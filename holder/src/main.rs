// rh-hold: the holder, one per headless conversation (docs/architecture.md §4).
// Standard library only. It never decodes agent output: it splits on byte 0x0A and
// nothing else, appends to out.log first, and forwards whole lines from there.
use std::collections::VecDeque;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::linux::net::SocketAddrExt;
use std::os::unix::fs::{DirBuilderExt, FileExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{SocketAddr, UnixDatagram, UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio, exit};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const PROTO: f64 = 1.0;
const KEEP_WRITTEN: usize = 64; // write ids in hello_ok (§4.6)
const CHUNK: usize = 1 << 20; // bytes per out message, unless a single line is longer
const ERR_LOG_MAX: u64 = 10 << 20; // err.log rotates past this (§4.3)
const MAX_DEPTH: usize = 32; // JSON nesting; a deeper line is a bad line (§4.4)
// After the agent exits: for its last output, then for rhodium to get it (§4.5).
const DRAIN: Duration = Duration::from_secs(2);

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

struct Holder {
    dir: PathBuf,
    sock: String,
    lock: String,
    out: File, // out.log, read and append
    st: Mutex<State>,
    cv: Condvar, // any change to State
    input: Mutex<Input>,
}

/// The agent's stdin and in.log, one writer at a time. stdin is None before start and after eof.
struct Input {
    stdin: Option<ChildStdin>,
    log: File,
}

#[derive(Default)]
struct State {
    size: u64,      // bytes in out.log
    lines_end: u64, // out.log is whole lines up to here
    started: bool,
    pid: Option<u32>,
    written: VecDeque<String>,
    writing: Option<String>, // the write going into stdin right now (§4.6)
    conn: Option<Arc<Conn>>, // the live connection; a newer hello replaces it
    exit: Option<String>,    // the exit message, once the agent is gone
    exit_sent: bool,
}

/// One connection from rhodium. Whole messages only: writers take `w`.
struct Conn {
    stream: UnixStream,
    w: Mutex<()>,
}

impl Conn {
    fn send(&self, msg: String) -> io::Result<()> {
        let _w = self.w.lock().unwrap();
        (&self.stream).write_all(msg.as_bytes())
    }
}

impl Holder {
    fn st(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap()
    }
}

impl State {
    /// Whether `conn` is the live connection, not one a newer hello replaced.
    fn live(&self, conn: &Conn) -> bool {
        self.conn.as_deref().is_some_and(|c| std::ptr::eq(c, conn))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = match args[1..] {
        ["--version"] => Ok(println!("{}", env!("CARGO_PKG_VERSION"))),
        ["run", dir, sock, lock, start_ms] => run(dir, sock, lock, start_ms.parse().unwrap_or(10_000)),
        ["stop-post", dir] => stop_post(dir),
        _ => {
            eprintln!("usage: rh-hold --version | run <dir> <sock> <lock> <start-timeout-ms> | stop-post <dir>");
            exit(2)
        }
    };
    if let Err(e) = result {
        die(e);
    }
}

fn die(e: impl std::fmt::Display) -> ! {
    eprintln!("rh-hold: {e}");
    exit(1)
}

fn run(dir: &str, sock: &str, lock: &str, start_ms: u64) -> io::Result<()> {
    let dir = PathBuf::from(dir);
    for d in [&dir, parent(sock), parent(lock)] {
        DirBuilder::new().recursive(true).mode(0o700).create(d)?;
    }
    // A fresh holder for this conversation: the last one's exit no longer applies.
    let _ = fs::remove_file(dir.join("exit"));
    let out = open(&dir.join("out.log"), true)?;
    let mut size = out.metadata()?.len();
    let mut last = [b'\n'];
    if size > 0 {
        out.read_exact_at(&mut last, size - 1)?;
    }
    if last[0] != b'\n' {
        // ponytail: a line the previous agent left unfinished is ended here, so it cannot
        // swallow this agent's first line. out.log then differs from stdout by this byte.
        (&out).write_all(b"\n")?;
        size += 1;
    }
    let log = open(&dir.join("in.log"), false)?;
    let _ = fs::remove_file(sock);
    let listener = UnixListener::bind(sock)?;
    fs::set_permissions(sock, fs::Permissions::from_mode(0o600))?;

    let state = State { size, lines_end: size, ..Default::default() };
    let h: &'static Holder = Box::leak(Box::new(Holder {
        dir,
        sock: sock.into(),
        lock: lock.into(),
        out,
        st: Mutex::new(state),
        cv: Condvar::new(),
        input: Mutex::new(Input { stdin: None, log }),
    }));
    notify_ready();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(start_ms));
        let st = h.st();
        if !st.started {
            let _ = fs::remove_file(&h.sock);
            exit(0);
        }
    });
    for stream in listener.incoming() {
        match stream {
            Ok(s) => drop(thread::spawn(move || serve(h, s))),
            Err(e) => eprintln!("rh-hold: accept: {e}"),
        }
    }
    Ok(())
}

fn parent(p: &str) -> &Path {
    Path::new(p).parent().unwrap_or(Path::new("/"))
}

/// Opens a file for appending, created 0600; `read` also lets it be read at an offset.
fn open(path: &Path, read: bool) -> io::Result<File> {
    OpenOptions::new().read(read).append(true).create(true).mode(0o600).open(path)
}

/// Tells systemd (Type=notify) the socket is listening, so systemd-run can return.
fn notify_ready() {
    let Ok(addr) = std::env::var("NOTIFY_SOCKET") else { return };
    let sent = UnixDatagram::unbound().and_then(|s| match addr.strip_prefix('@') {
        Some(name) => s.send_to_addr(b"READY=1", &SocketAddr::from_abstract_name(name)?),
        None => s.send_to(b"READY=1", &addr),
    });
    if let Err(e) = sent {
        eprintln!("rh-hold: cannot notify systemd: {e}");
    }
}

/// One connection: hello first, then requests until it closes or breaks the protocol.
fn serve(h: &'static Holder, stream: UnixStream) {
    let Ok(w) = stream.try_clone() else { return };
    let conn = Arc::new(Conn { stream: w, w: Mutex::new(()) });
    let mut lines = BufReader::new(stream).split(b'\n');
    let mut next = || lines.next()?.ok().and_then(|l| parse(&l));
    let offset = match next() {
        Some(m) if m.s("type") == Some("hello") && m.n("proto") == Some(PROTO) => {
            m.n("offset").filter(|o| *o >= 0.0 && o.fract() == 0.0)
        }
        _ => None,
    };
    if let Some(offset) = offset {
        let sent = {
            let mut st = h.st();
            if let Some(old) = st.conn.replace(conn.clone()) {
                let _ = old.stream.shutdown(Shutdown::Both);
            }
            h.cv.notify_all();
            let pid = st.pid.map_or("null".into(), |p| p.to_string());
            let written: Vec<String> = st.written.iter().map(|id| q(id)).collect();
            let writing = st.writing.as_deref().map_or("null".into(), q);
            // Sent under the lock, so it is the first message here: an ack for `writing`
            // takes the lock to find this connection, and so comes after (§4.4, §4.6).
            // A new socket's buffer is empty and hello_ok is a few KB, so this does not block.
            conn.send(format!(
                "{{\"type\":\"hello_ok\",\"proto\":1,\"pid\":{pid},\"size\":{size},\
                 \"written\":[{written}],\"writing\":{writing}}}\n",
                size = st.size,
                written = written.join(",")
            ))
        };
        if sent.is_ok() {
            let c = conn.clone();
            thread::spawn(move || forward(h, c, offset as u64));
            while let Some(m) = next() {
                if handle(h, &conn, &m).is_err() {
                    break;
                }
            }
        }
    }
    let _ = conn.stream.shutdown(Shutdown::Both);
    let mut st = h.st();
    if st.live(&conn) {
        st.conn = None;
        h.cv.notify_all();
    }
}

/// One request. Err drops the connection; the holder carries on.
/// Once a newer hello replaces `conn`, nothing more from it is handled (§4.4): each request
/// checks under the lock it acts under, so a hello cannot slip in between.
fn handle(h: &'static Holder, conn: &Conn, m: &J) -> Result<(), ()> {
    match m.s("type").ok_or(())? {
        "start" => start(h, conn, m),
        "write" => match (m.s("id"), m.s("line")) {
            (Some(id), Some(line)) if !line.contains('\n') => write_line(h, conn, id, line),
            _ => Err(()),
        },
        "eof" => {
            let mut input = h.input.lock().unwrap();
            // st only while stdin is set: the lock order in start().
            if input.stdin.is_some() && !h.st().live(conn) {
                return Err(());
            }
            Ok(input.stdin = None)
        }
        "signal" => {
            let sig = match m.s("sig") {
                Some("TERM") => 15,
                Some("KILL") => 9,
                _ => return Err(()),
            };
            let st = h.st();
            if !st.live(conn) {
                return Err(());
            }
            if let (Some(pid), None) = (st.pid, &st.exit) {
                // The agent leads its own process group, so this reaches what it started too.
                unsafe { kill(-(pid as i32), sig) };
            }
            Ok(())
        }
        _ => Err(()),
    }
}

fn start(h: &'static Holder, conn: &Conn, m: &J) -> Result<(), ()> {
    let argv = m.get("argv").and_then(J::arr).ok_or(())?;
    let argv: Vec<&str> = argv.iter().map(J::str).collect::<Option<_>>().ok_or(())?;
    let Some(J::Obj(env)) = m.get("env") else { return Err(()) };
    let env: Vec<(&str, &str)> =
        env.iter().map(|(k, v)| Some((k.as_str(), v.str()?))).collect::<Option<_>>().ok_or(())?;
    let cwd = m.s("cwd").ok_or(())?;
    if argv.is_empty() {
        return Err(());
    }
    // Held until pid is set, so no hello sees the agent started but without a pid.
    let mut st = h.st();
    if st.started || !st.live(conn) {
        return Err(());
    }
    st.started = true;
    let spawned = take_lock(&h.lock).and_then(|lock| {
        let child = Command::new(argv[0])
            .args(&argv[1..])
            .env_clear()
            .envs(env)
            .current_dir(cwd)
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        Ok((lock, child))
    });
    let (lock, mut child) = match spawned {
        Ok(x) => x,
        Err(e) => {
            drop(st);
            log_err(&h.dir, format!("rh-hold: cannot start {}: {e}\n", argv[0]).as_bytes());
            finish(h, Some(127), None);
        }
    };
    let pid = child.id();
    let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    // Lock order: start takes st then input, while write_line and eof take input then st.
    // No deadlock only because those two touch st only when stdin is set, and stdin is
    // None until this line sets it. Keep it so, or take the locks in one order.
    h.input.lock().unwrap().stdin = child.stdin.take();
    st.pid = Some(pid);
    drop(st);
    let _ = conn.send(format!("{{\"type\":\"started\",\"pid\":{pid}}}\n"));

    let (drained, done) = mpsc::channel();
    let err_drained = drained.clone();
    thread::spawn(move || {
        pump_out(h, stdout);
        let _ = drained.send(());
    });
    thread::spawn(move || {
        let mut stderr = stderr;
        let mut buf = vec![0; 64 << 10];
        while let Ok(n @ 1..) = stderr.read(&mut buf) {
            log_err(&h.dir, &buf[..n]);
        }
        let _ = err_drained.send(());
    });
    thread::spawn(move || {
        let _lock = lock; // held until the holder exits
        let status = child.wait();
        // Both pumps, within one DRAIN.
        // ponytail: output still unread after DRAIN (a grandchild holding stdout or stderr) is not waited for.
        let deadline = Instant::now() + DRAIN;
        for _ in 0..2 {
            let _ = done.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        }
        match status {
            Ok(s) => finish(h, s.code(), s.signal().map(sig_name).as_deref()),
            Err(_) => finish(h, None, None),
        }
    });
    Ok(())
}

/// The conversation lock (§4.3): held from start until the holder exits.
fn take_lock(path: &str) -> io::Result<File> {
    let f = OpenOptions::new().write(true).create(true).truncate(false).mode(0o600).open(path)?;
    f.try_lock().map_err(|_| io::Error::other("the conversation lock is held by another process"))?;
    Ok(f)
}

/// Agent stdout to out.log, whatever rhodium is doing; forwarders read it back from there.
fn pump_out(h: &Holder, mut src: impl Read) {
    let mut buf = vec![0; 64 << 10];
    loop {
        let n = match src.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        if let Err(e) = (&h.out).write_all(&buf[..n]) {
            die(format!("cannot write out.log: {e}"));
        }
        let mut st = h.st();
        st.size += n as u64;
        if let Some(i) = buf[..n].iter().rposition(|&b| b == b'\n') {
            st.lines_end = st.size - (n - i - 1) as u64;
        }
        h.cv.notify_all();
    }
}

/// Agent stderr to err.log, rotated to err.log.1 past ERR_LOG_MAX.
fn log_err(dir: &Path, bytes: &[u8]) {
    let path = dir.join("err.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > ERR_LOG_MAX) {
        let _ = fs::rename(&path, dir.join("err.log.1"));
    }
    let _ = open(&path, false).and_then(|mut f| f.write_all(bytes));
}

/// Sends whole lines of out.log from `pos` on, live, until this connection is replaced or gone.
/// After the agent exits and everything is sent, sends exit.
fn forward(h: &Holder, conn: Arc<Conn>, mut pos: u64) {
    loop {
        let (end, exit) = {
            let mut st = h.st();
            loop {
                if !st.live(&conn) {
                    return;
                }
                if st.lines_end > pos || st.exit.is_some() {
                    break;
                }
                st = h.cv.wait(st).unwrap();
            }
            (st.lines_end, st.exit.clone())
        };
        if end > pos {
            let data = read_lines(&h.out, pos, end).unwrap_or_else(|e| die(format!("cannot read out.log: {e}")));
            let msg = format!("{{\"type\":\"out\",\"pos\":{pos},\"data\":\"{}\"}}\n", b64(&data));
            if conn.send(msg).is_err() {
                return;
            }
            pos += data.len() as u64;
        } else if let Some(exit) = exit {
            let _ = conn.send(exit);
            h.st().exit_sent = true;
            h.cv.notify_all();
            return;
        }
    }
}

/// Bytes from `pos` up to the last newline within CHUNK, or to the end of the first line
/// if that is longer. `end` must follow a newline.
fn read_lines(f: &File, pos: u64, end: u64) -> io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    loop {
        let have = buf.len();
        let more = ((end - pos) as usize - have).min(CHUNK);
        if more == 0 {
            return Ok(buf);
        }
        buf.resize(have + more, 0);
        f.read_exact_at(&mut buf[have..], pos + have as u64)?;
        if let Some(i) = buf[have..].iter().rposition(|&b| b == b'\n') {
            buf.truncate(have + i + 1);
            return Ok(buf);
        }
    }
}

/// in.log first (§4.5: out.log's size, a space, the line), then the agent's stdin, then ack.
/// Until the line is in, hello_ok names it in `writing`; the ack goes to whichever connection
/// is live by then (§4.6).
fn write_line(h: &Holder, conn: &Conn, id: &str, line: &str) -> Result<(), ()> {
    let mut input = h.input.lock().unwrap();
    let Input { stdin, log } = &mut *input;
    let Some(stdin) = stdin else { return Err(()) };
    let at = {
        let mut st = h.st();
        // Replaced while this request waited for stdin: the new hello_ok has it in neither
        // written nor writing, so rhodium writes it again itself.
        if !st.live(conn) {
            return Err(());
        }
        st.writing = Some(id.into());
        st.size
    };
    // ponytail: logged even when the agent turns out to be gone; in.log then has one line
    // the agent never got, just before its exit.
    if let Err(e) = log.write_all(format!("{at} {line}\n").as_bytes()) {
        die(format!("cannot write in.log: {e}"));
    }
    // ponytail: a stdin the agent stops reading blocks this connection; a new hello gets a fresh one.
    let ok = stdin.write_all(format!("{line}\n").as_bytes()).is_ok();
    // input is held until writing and written are settled: the next write sets writing once it
    // has input, and this one must not clear that mark.
    let live = {
        let mut st = h.st();
        st.writing = None;
        if !ok {
            return Ok(()); // the agent is gone; its exit follows
        }
        st.written.push_back(id.into());
        if st.written.len() > KEEP_WRITTEN {
            st.written.pop_front();
        }
        st.conn.clone()
    };
    drop(input);
    if let Some(c) = live {
        let _ = c.send(format!("{{\"type\":\"ack\",\"id\":{}}}\n", q(id)));
    }
    Ok(())
}

/// The agent is gone: write the exit file, let a connected rhodium get the rest, exit.
fn finish(h: &Holder, code: Option<i32>, signal: Option<&str>) -> ! {
    let wrote = write_exit(&h.dir, "agent", code, signal);
    if let Err(e) = &wrote {
        eprintln!("rh-hold: cannot write exit: {e}");
    }
    let mut st = h.st();
    st.exit = Some(format!("{{\"type\":\"exit\",{}}}\n", exit_fields(code, signal)));
    h.cv.notify_all();
    let deadline = Instant::now() + DRAIN;
    while st.conn.is_some() && !st.exit_sent {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        st = h.cv.wait_timeout(st, left).unwrap().0;
    }
    let _ = fs::remove_file(&h.sock);
    exit(if wrote.is_ok() { 0 } else { 1 })
}

fn exit_fields(code: Option<i32>, signal: Option<&str>) -> String {
    let code = code.map_or("null".into(), |c| c.to_string());
    let signal = signal.map_or("null".into(), q);
    format!("\"code\":{code},\"signal\":{signal}")
}

/// The exit file (§4.3): one line of JSON, by the holder for its agent or by ExecStopPost.
fn write_exit(dir: &Path, from: &str, code: Option<i32>, signal: Option<&str>) -> io::Result<()> {
    let tmp = dir.join("exit.tmp");
    let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(format!("{{\"from\":\"{from}\",{}}}\n", exit_fields(code, signal)).as_bytes())?;
    fs::rename(tmp, dir.join("exit"))
}

/// ExecStopPost: the unit is over. If the agent's exit was not written, the holder itself
/// died; record its status, which systemd passes in EXIT_CODE and EXIT_STATUS.
fn stop_post(dir: &str) -> io::Result<()> {
    let dir = Path::new(dir);
    if dir.join("exit").exists() {
        return Ok(());
    }
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let status = std::env::var("EXIT_STATUS").unwrap_or_default();
    match std::env::var("EXIT_CODE").as_deref() {
        Ok("exited") => write_exit(dir, "holder", status.parse().ok(), None),
        Ok(_) => write_exit(dir, "holder", None, Some(&status)),
        Err(_) => write_exit(dir, "holder", None, None),
    }
}

/// Linux signal names as systemd writes them in EXIT_STATUS, so both exit writers agree.
fn sig_name(n: i32) -> String {
    const NAMES: [&str; 31] = [
        "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM",
        "TERM", "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF",
        "WINCH", "IO", "PWR", "SYS",
    ];
    NAMES.get((n - 1) as usize).map_or(n.to_string(), |s| s.to_string())
}

// ---- JSON: just enough for hold/1. Unknown fields are parsed and ignored. ----

enum J {
    Lit, // true, false, null: hold/1 reads none of them
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    fn get(&self, key: &str) -> Option<&J> {
        let J::Obj(kv) = self else { return None };
        kv.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn str(&self) -> Option<&str> {
        if let J::Str(s) = self { Some(s) } else { None }
    }
    fn arr(&self) -> Option<&Vec<J>> {
        if let J::Arr(a) = self { Some(a) } else { None }
    }
    fn s(&self, key: &str) -> Option<&str> {
        self.get(key)?.str()
    }
    fn n(&self, key: &str) -> Option<f64> {
        if let Some(J::Num(n)) = self.get(key) { Some(*n) } else { None }
    }
}

fn parse(line: &[u8]) -> Option<J> {
    let mut p = P { s: line, i: 0, depth: 0 };
    let v = p.value()?;
    p.ws();
    (p.i == line.len()).then_some(v)
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
    depth: usize, // arrays and objects open here; each costs a stack frame, hence MAX_DEPTH
}

impl P<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }
    fn eat(&mut self, lit: &str) -> Option<()> {
        self.s[self.i..].starts_with(lit.as_bytes()).then(|| self.i += lit.len())
    }
    /// Items up to `close`, each read by `item`, separated by commas.
    fn list(&mut self, close: u8, mut item: impl FnMut(&mut Self) -> Option<()>) -> Option<()> {
        if self.depth == MAX_DEPTH {
            return None;
        }
        self.depth += 1;
        self.i += 1;
        self.ws();
        if self.peek() != Some(close) {
            loop {
                item(self)?;
                self.ws();
                match self.peek()? {
                    b',' => self.i += 1,
                    c if c == close => break,
                    _ => return None,
                }
            }
        }
        self.i += 1;
        self.depth -= 1;
        Some(())
    }
    fn value(&mut self) -> Option<J> {
        self.ws();
        match self.peek()? {
            b'{' => {
                let mut kv = Vec::new();
                self.list(b'}', |p| {
                    p.ws();
                    let k = p.string()?;
                    p.ws();
                    p.eat(":")?;
                    Some(kv.push((k, p.value()?)))
                })?;
                Some(J::Obj(kv))
            }
            b'[' => {
                let mut a = Vec::new();
                self.list(b']', |p| Some(a.push(p.value()?)))?;
                Some(J::Arr(a))
            }
            b'"' => self.string().map(J::Str),
            b't' => self.eat("true").map(|_| J::Lit),
            b'f' => self.eat("false").map(|_| J::Lit),
            b'n' => self.eat("null").map(|_| J::Lit),
            _ => {
                let start = self.i;
                while matches!(self.peek(), Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')) {
                    self.i += 1;
                }
                std::str::from_utf8(&self.s[start..self.i]).ok()?.parse().ok().map(J::Num)
            }
        }
    }
    fn string(&mut self) -> Option<String> {
        self.eat("\"")?;
        let mut out = Vec::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let e = self.peek()?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\x08',
                        b'f' => '\x0c',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                self.eat("\\u")?;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return None;
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                hi
                            };
                            char::from_u32(cp)?
                        }
                        _ => return None,
                    };
                    out.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
                }
                c if c < 0x20 => return None,
                c => out.push(c),
            }
        }
    }
    fn hex4(&mut self) -> Option<u32> {
        let h = self.s.get(self.i..self.i + 4)?;
        self.i += 4;
        if !h.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        u32::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    }
}

/// A JSON string.
fn q(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            o.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    o
}
