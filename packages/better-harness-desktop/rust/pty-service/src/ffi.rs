//! Safe wrapper over the C PTY core plus the libc calls that are simpler to keep
//! in Rust: reading and writing the master, reaping the child, and signalling.
//!
//! One [`PtyProcess`] owns one master fd and one child pid. Dropping it closes
//! the master (sending the child SIGHUP once nothing holds the terminal open)
//! but does not block on the child; the driver reaps explicitly so it can report
//! the exit status.

use std::ffi::{CString, c_char, c_int};
use std::io;

unsafe extern "C" {
    fn harness_pty_spawn(
        file: *const c_char,
        argv: *const *const c_char,
        envp: *const *const c_char,
        cwd: *const c_char,
        rows: u16,
        cols: u16,
        out_master: *mut c_int,
        out_pid: *mut c_int,
    ) -> c_int;
    fn harness_pty_resize(master: c_int, rows: u16, cols: u16) -> c_int;
}

/// How a reaped child ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitStatus {
    Exited(i32),
    Signaled(i32),
}

/// A spawned command attached to a pseudo-terminal.
pub struct PtyProcess {
    master: c_int,
    pid: libc::pid_t,
}

impl PtyProcess {
    /// Spawn `command` with `args` under a new PTY. `env`, when `Some`, fully
    /// replaces the child environment; `None` inherits the driver's.
    pub fn spawn(
        command: &str,
        args: &[String],
        cwd: Option<&str>,
        env: Option<&[(String, String)]>,
        rows: u16,
        cols: u16,
    ) -> io::Result<Self> {
        let file = CString::new(command)
            .map_err(|_| io::Error::other("command contains a NUL byte"))?;

        // argv[0] is the command itself, then the caller's args, then NULL.
        let mut argv_owned: Vec<CString> = Vec::with_capacity(args.len() + 1);
        argv_owned.push(file.clone());
        for arg in args {
            argv_owned.push(
                CString::new(arg.as_str())
                    .map_err(|_| io::Error::other("an argument contains a NUL byte"))?,
            );
        }
        let mut argv: Vec<*const c_char> = argv_owned.iter().map(|s| s.as_ptr()).collect();
        argv.push(std::ptr::null());

        // envp is optional; keep the owned strings alive alongside argv.
        let env_owned: Option<Vec<CString>> = match env {
            Some(pairs) => Some(
                pairs
                    .iter()
                    .map(|(key, value)| {
                        CString::new(format!("{key}={value}"))
                            .map_err(|_| io::Error::other("an env entry contains a NUL byte"))
                    })
                    .collect::<io::Result<Vec<_>>>()?,
            ),
            None => None,
        };
        let envp: Option<Vec<*const c_char>> = env_owned.as_ref().map(|entries| {
            let mut raw: Vec<*const c_char> = entries.iter().map(|s| s.as_ptr()).collect();
            raw.push(std::ptr::null());
            raw
        });

        let cwd_owned = match cwd {
            Some(path) => Some(
                CString::new(path)
                    .map_err(|_| io::Error::other("cwd contains a NUL byte"))?,
            ),
            None => None,
        };

        let mut master: c_int = -1;
        let mut pid: c_int = -1;
        // SAFETY: every pointer is either a valid CString for the duration of the
        // call or a null terminator; out_master/out_pid point at locals.
        let rc = unsafe {
            harness_pty_spawn(
                file.as_ptr(),
                argv.as_ptr(),
                envp.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
                cwd_owned.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                rows,
                cols,
                &mut master,
                &mut pid,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { master, pid })
    }

    pub fn master_fd(&self) -> c_int {
        self.master
    }

    pub fn pid(&self) -> libc::pid_t {
        self.pid
    }

    /// Change the terminal window size.
    pub fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
        // SAFETY: `master` is a live fd owned by this process.
        let rc = unsafe { harness_pty_resize(self.master, rows, cols) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Write to the master; the child reads it on its stdin.
    pub fn write(&self, bytes: &[u8]) -> io::Result<usize> {
        // SAFETY: `master` is a live fd; `bytes` is a valid slice.
        let written =
            unsafe { libc::write(self.master, bytes.as_ptr().cast(), bytes.len()) };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(written as usize)
    }

    /// Read available master output. `Ok(0)` means EOF: the slave side is fully
    /// closed and the child has (or is about to have) exited.
    pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        // SAFETY: `master` is a live fd; `buf` is a valid mutable slice.
        let read = unsafe { libc::read(self.master, buf.as_mut_ptr().cast(), buf.len()) };
        if read < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(read as usize)
    }

    /// Send a signal to the child process.
    pub fn signal(&self, signal: c_int) -> io::Result<()> {
        // SAFETY: kill on a pid this process spawned; harmless if already reaped.
        let rc = unsafe { libc::kill(self.pid, signal) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Reap the child, blocking until it exits. Returns how it ended.
    pub fn wait(&self) -> io::Result<ExitStatus> {
        let mut status: c_int = 0;
        // SAFETY: waitpid on a child of this process; `status` is a valid local.
        let rc = unsafe { libc::waitpid(self.pid, &mut status, 0) };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(decode_status(status))
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        if self.master >= 0 {
            // SAFETY: closing a live fd once; the master is never shared.
            unsafe { libc::close(self.master) };
            self.master = -1;
        }
    }
}

fn decode_status(status: c_int) -> ExitStatus {
    // libc exposes the WIF* macros as functions on the crate.
    if libc::WIFEXITED(status) {
        ExitStatus::Exited(libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        ExitStatus::Signaled(libc::WTERMSIG(status))
    } else {
        // Stopped/continued are not reachable without WUNTRACED/WCONTINUED.
        ExitStatus::Exited(-1)
    }
}
