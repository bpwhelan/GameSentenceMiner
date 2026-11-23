//! Deterministic process-loopback and recognizer substitutes for speech IPC measurements.
use std::{
    env,
    io::{self, Read, Write},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn main() -> io::Result<()> {
    let live = env::var("GSM_SPEECH_FIXTURE").as_deref() != Ok("burst");
    let (size, count) = if live { (640, 64) } else { (32768, 2048) };
    let mut block = vec![42u8; size];
    let now = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64
    };
    let mut output = io::stdout().lock();
    if env::args().any(|arg| arg == "--root-pid") {
        for n in 0..count {
            block[..8].copy_from_slice(&(n as u64).to_le_bytes());
            output.write_all(&block)?;
            output.flush()?;
            if live {
                thread::sleep(Duration::from_millis(20));
            }
        }
    } else {
        let mut input = io::stdin().lock();
        for n in 0..count {
            input.read_exact(&mut block)?;
            assert_eq!(&block[..8], &(n as u64).to_le_bytes());
            assert!(block[8..].iter().all(|b| *b == 42));
            if live || n % 32 == 31 {
                writeln!(
                    output,
                    r#"{{"type":"recognition","text":"結果{n}","final":{},"offset":{}}}"#,
                    n % 2 == 1,
                    now()
                )?;
                output.flush()?;
            }
        }
        assert_eq!(input.read(&mut block)?, 0);
    }
    Ok(())
}
