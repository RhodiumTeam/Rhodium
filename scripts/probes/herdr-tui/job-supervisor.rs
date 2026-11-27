// Console-subsystem probe. Reuse the preview holder's exact Job setup before spawning.
#[allow(dead_code)]
#[path = "../../../holder/src/windows.rs"]
mod windows;
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::process::{Command, exit};
use std::time::Duration;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn QueryInformationJobObject(
        job: RawHandle,
        class: i32,
        data: *mut u32,
        len: u32,
        used: *mut u32,
    ) -> i32;
}

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let job = windows::own_tree().unwrap();
    let mut agent = Command::new(&args[0]).args(&args[1..]).spawn().unwrap();
    // JOBOBJECT_BASIC_PROCESS_ID_LIST: two u32 counters, followed by pointer-sized IDs.
    let mut buf = [0usize; 32];
    for _ in 0..500 {
        let ok = unsafe {
            QueryInformationJobObject(
                job.as_raw_handle(),
                3,
                buf.as_mut_ptr().cast(),
                size_of_val(&buf) as u32,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0);
        let count = buf[0] as u32;
        if count >= 3 {
            std::fs::write("job-count", count.to_string()).unwrap();
            println!("JOB_TREE_READY");
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    exit(agent.wait().unwrap().code().unwrap_or(1));
}
