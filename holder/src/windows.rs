// Local byte pipes. Each pending read/write owns its OVERLAPPED and event: a
// blocked reader must not prevent the forwarder from writing to the same pipe.
use std::ffi::c_void;

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::os::windows::process::CommandExt;
use std::process::{Command, exit};
use std::ptr::{null, null_mut};
use std::sync::Arc;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[repr(C)]
struct Security {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}

#[repr(C)]
#[derive(Default)]
struct Overlapped {
    internal: usize,
    count: usize,
    offset: [u32; 2],
    event: RawHandle,
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        version: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(ptr: *mut c_void) -> *mut c_void;
    fn CreateNamedPipeW(
        name: *const u16,
        mode: u32,
        pipe_mode: u32,
        instances: u32,
        out_size: u32,
        in_size: u32,
        timeout: u32,
        security: *const Security,
    ) -> RawHandle;
    fn ConnectNamedPipe(pipe: RawHandle, operation: *mut Overlapped) -> i32;
    fn DisconnectNamedPipe(pipe: RawHandle) -> i32;
    fn CancelIoEx(pipe: RawHandle, operation: *const Overlapped) -> i32;
    fn CreateEventW(security: *const Security, manual: i32, initial: i32, name: *const u16) -> RawHandle;
    fn ReadFile(pipe: RawHandle, data: *mut u8, size: u32, count: *mut u32, operation: *mut Overlapped) -> i32;
    fn WriteFile(pipe: RawHandle, data: *const u8, size: u32, count: *mut u32, operation: *mut Overlapped) -> i32;
    fn GetOverlappedResult(pipe: RawHandle, operation: *mut Overlapped, count: *mut u32, wait: i32) -> i32;
    fn CreateJobObjectW(security: *const Security, name: *const u16) -> RawHandle;
    fn SetInformationJobObject(job: RawHandle, class: i32, data: *const c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
    fn GetCurrentProcess() -> RawHandle;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
    fn TerminateProcess(process: RawHandle, code: u32) -> i32;
}

fn handle(raw: RawHandle) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw as isize == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
    }
}

fn transfer(pipe: RawHandle, start: impl FnOnce(*mut Overlapped) -> i32, connecting: bool) -> io::Result<usize> {
    let event = handle(unsafe { CreateEventW(null(), 1, 0, null()) })?;
    let mut op = Overlapped { event: event.as_raw_handle(), ..Default::default() };
    if start(&mut op) == 0 {
        let err = io::Error::last_os_error();
        if connecting && err.raw_os_error() == Some(535) {
            return Ok(0);
        } // ERROR_PIPE_CONNECTED
        if err.raw_os_error() != Some(997) {
            return Err(err);
        } // ERROR_IO_PENDING
    }
    let mut bytes = 0;
    if unsafe { GetOverlappedResult(pipe, &mut op, &mut bytes, 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(bytes as usize)
}

pub struct Listener {
    name: Vec<u16>,
    next: OwnedHandle,
    proof: String,
}

impl Listener {
    fn instance(name: &[u16], first: bool) -> io::Result<OwnedHandle> {
        // Owner and system only; remote clients are rejected even with the same account.
        let sddl: Vec<u16> = "D:P(A;;GA;;;OW)(A;;GA;;;SY)".encode_utf16().chain(Some(0)).collect();
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut())
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let sa = Security { length: size_of::<Security>() as u32, descriptor, inherit: 0 };
        let first_instance = if first { 0x80000 } else { 0 };
        let pipe = handle(unsafe {
            CreateNamedPipeW(name.as_ptr(), 3 | 0x40000000 | first_instance, 8, 255, 65536, 65536, 0, &sa)
        });
        unsafe { LocalFree(descriptor) };
        pipe
    }

    pub fn bind(name: &str) -> io::Result<Self> {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        Ok(Self {
            next: Self::instance(&name, true)?,
            name,
            proof: std::env::var("RHODIUM_PIPE_PROOF").map_err(io::Error::other)?,
        })
    }

    pub fn accept(&mut self) -> io::Result<Stream> {
        loop {
            let pipe = self.next.as_raw_handle();
            let connected = transfer(pipe, |op| unsafe { ConnectNamedPipe(pipe, op) }, true);
            // Keep the name reserved even if a client vanished between open and accept.
            let next = Self::instance(&self.name, false)?;
            let stream = Stream(Arc::new(std::mem::replace(&mut self.next, next)), self.proof.clone());
            match connected {
                Ok(_) => return Ok(stream),
                Err(e) if matches!(e.raw_os_error(), Some(109 | 232 | 233)) => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

pub struct Stream(Arc<OwnedHandle>, String);

impl Stream {
    pub fn greet(&self) -> io::Result<()> {
        writeln!(&mut &*self, "{}", self.1)
    }
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self(self.0.clone(), self.1.clone()))
    }
    pub fn shutdown(&self, _: Shutdown) -> io::Result<()> {
        let h = self.0.as_raw_handle();
        unsafe {
            CancelIoEx(h, null());
            DisconnectNamedPipe(h);
        }
        Ok(())
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let pipe = self.0.as_raw_handle();
        transfer(
            pipe,
            |op| unsafe { ReadFile(pipe, buf.as_mut_ptr(), buf.len().min(u32::MAX as usize) as u32, null_mut(), op) },
            false,
        )
    }
}

impl Write for &Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let pipe = self.0.as_raw_handle();
        transfer(
            pipe,
            |op| unsafe { WriteFile(pipe, buf.as_ptr(), buf.len().min(u32::MAX as usize) as u32, null_mut(), op) },
            false,
        )
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    processes: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}
#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io_counters: [u64; 6],
    memory: [usize; 4],
}

// The caller keeps the non-inheritable handle until it exits.
fn kill_on_close(extra_flags: u32) -> io::Result<OwnedHandle> {
    let job = handle(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits = ExtendedLimits::default();
    limits.basic.flags = 0x2000 | extra_flags; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            9,
            (&limits as *const ExtendedLimits).cast(),
            size_of::<ExtendedLimits>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

fn assign(job: &OwnedHandle, process: RawHandle) -> io::Result<()> {
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// The holder and its agent tree share one lifetime.
pub fn own_tree() -> io::Result<OwnedHandle> {
    let job = kill_on_close(0)?;
    assign(&job, unsafe { GetCurrentProcess() })?;
    Ok(job)
}

// A completed scheduler action can stay Ready even when it returns a failure code.
pub fn run_task(config: &str) -> io::Result<()> {
    let exe = std::env::current_exe()?.with_file_name("rhodium.exe");
    // Stopping the task stops the controller. Its independent holders must survive.
    let job = kill_on_close(0x1000)?; // JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
    let mut retries = 0;
    loop {
        let started = std::time::Instant::now();
        let code = match Command::new(&exe).args(["--config", config]).creation_flags(CREATE_NO_WINDOW).spawn() {
            Ok(mut daemon) => {
                if let Err(e) = assign(&job, daemon.as_raw_handle()) {
                    let _ = daemon.kill();
                    return Err(e);
                }
                daemon.wait()?.code().unwrap_or(1)
            }
            Err(e) => {
                eprintln!("rh-hold: cannot start controller: {e}");
                1
            }
        };
        if started.elapsed().as_secs() >= 60 {
            retries = 0;
        }
        if code == 0 || retries == 5 {
            exit(code);
        }
        // 2, 4, 8, 16, 32 seconds for consecutive failures; a healthy minute replenishes the budget.
        std::thread::sleep(std::time::Duration::from_secs(2 << retries));
        retries += 1;
    }
}

pub fn terminate(pid: u32) -> io::Result<()> {
    let child = handle(unsafe { OpenProcess(1, 0, pid) })?; // PROCESS_TERMINATE
    if unsafe { TerminateProcess(child.as_raw_handle(), 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// The CLI listener shares the holder's private pipe ACL. The parent owns the
// router and can answer requests out of order (an approval may take minutes).
pub fn serve_cli(name: &str) -> io::Result<()> {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::sync::{Mutex, mpsc};
    use std::thread;
    let mut listener = Listener::bind(name)?;
    let replies = Arc::new(Mutex::new(HashMap::<u64, mpsc::Sender<String>>::new()));
    let pending = replies.clone();
    thread::spawn(move || {
        for line in io::stdin().lock().lines().map_while(Result::ok) {
            if let Some((id, reply)) = line.split_once(' ')
                && let Ok(id) = id.parse::<u64>()
                && let Some(tx) = pending.lock().unwrap().remove(&id)
            {
                let _ = tx.send(reply.to_owned());
            }
        }
        std::process::exit(0); // the control plane is gone
    });
    println!("ready");
    for id in 0u64.. {
        let stream = listener.accept()?;
        let pending = replies.clone();
        thread::spawn(move || -> io::Result<()> {
            stream.greet()?;
            let mut reader = BufReader::new(stream.try_clone()?).take((1 << 20) + 1);
            let mut line = String::new();
            reader.read_line(&mut line)?;
            if !line.ends_with('\n') || line.len() > 1 << 20 {
                return Ok(());
            }
            let (tx, rx) = mpsc::channel();
            pending.lock().unwrap().insert(id, tx);
            writeln!(io::stdout().lock(), "{id} {}", line.trim_end())?;
            if let Ok(reply) = rx.recv() {
                writeln!(&stream, "{reply}")?;
                unsafe extern "system" {
                    fn FlushFileBuffers(file: RawHandle) -> i32;
                }
                unsafe {
                    FlushFileBuffers(stream.0.as_raw_handle());
                }
            }
            Ok(())
        });
    }
    Ok(())
}
