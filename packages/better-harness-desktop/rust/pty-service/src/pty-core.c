// PTY core for the desktop terminal driver.
//
// Only the fiddly parts of putting a child under a controlling terminal live in
// C: opening the master/slave pair, giving the child a controlling TTY, and
// pushing a window size. The Rust side owns the byte I/O, process reaping, and
// signalling through libc, so this file has no state and no threads.
//
// POSIX only. Windows ConPTY is a separate backend the POC does not include.

#define _GNU_SOURCE
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <util.h>
#else
// Linux keeps openpty/forkpty in <pty.h> and login_tty in <utmp.h>.
#include <pty.h>
#include <utmp.h>
#endif

// Fill a winsize, clamping zero to a sane default so a caller that omits a size
// still gets a terminal a curses program will accept.
static struct winsize harness_pty_winsize(unsigned short rows, unsigned short cols) {
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_row = rows ? rows : 24;
    ws.ws_col = cols ? cols : 80;
    return ws;
}

// Spawn `file` under a fresh pseudo-terminal.
//
// On success returns 0, writes the master fd to *out_master and the child pid
// to *out_pid. On failure returns -1 with errno set and touches nothing the
// caller must clean up. `argv` is NULL-terminated; `envp`, when non-NULL, fully
// replaces the child environment (NULL inherits the parent's). `cwd`, when
// non-NULL and non-empty, is entered before exec.
int harness_pty_spawn(const char *file,
                      char *const argv[],
                      char *const envp[],
                      const char *cwd,
                      unsigned short rows,
                      unsigned short cols,
                      int *out_master,
                      int *out_pid) {
    if (file == NULL || argv == NULL || out_master == NULL || out_pid == NULL) {
        errno = EINVAL;
        return -1;
    }
    struct winsize ws = harness_pty_winsize(rows, cols);
    int master = -1;
    int slave = -1;
    if (openpty(&master, &slave, NULL, NULL, &ws) != 0) {
        return -1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        int saved = errno;
        close(master);
        close(slave);
        errno = saved;
        return -1;
    }

    if (pid == 0) {
        // Child. login_tty makes `slave` the controlling terminal, calls
        // setsid, and dups it onto 0/1/2, closing the original descriptor. The
        // master is not ours to keep once we have the slave wired in.
        close(master);
        if (login_tty(slave) != 0) {
            _exit(127);
        }
        if (cwd != NULL && cwd[0] != '\0' && chdir(cwd) != 0) {
            _exit(127);
        }
        if (envp != NULL) {
            execve(file, argv, envp);
        } else {
            execvp(file, argv);
        }
        // Only reached if exec failed; the parent sees this as an immediate exit.
        _exit(127);
    }

    // Parent. The slave belongs to the child now; holding it open would keep the
    // master readable after the child exits and stall EOF detection.
    close(slave);
    *out_master = master;
    *out_pid = (int)pid;
    return 0;
}

// Push a new window size to the terminal behind `master`. Children reading the
// SIGWINCH-triggering winsize (curses, `stty size`) see the update. Returns 0
// on success, -1 with errno set otherwise.
int harness_pty_resize(int master, unsigned short rows, unsigned short cols) {
    struct winsize ws = harness_pty_winsize(rows, cols);
    return ioctl(master, TIOCSWINSZ, &ws);
}
