use std::collections::HashMap;
use std::path::Path;

pub struct Fixtures {
    by_size: HashMap<usize, Vec<u8>>,
}

impl Fixtures {
    pub fn load(dir: &Path, sizes: &[i64], large: Option<i64>) -> Self {
        let mut by_size = HashMap::new();
        for &mb in sizes {
            let path = dir.join(format!("{mb}mb.bin"));
            match std::fs::read(&path) {
                Ok(b) => { by_size.insert(mb as usize, b); }
                Err(_) => eprintln!("warn: fixture {} missing — skipping", path.display()),
            }
        }
        if let Some(mb) = large {
            let path = dir.join(format!("{mb}mb.bin"));
            if let Ok(b) = std::fs::read(&path) {
                by_size.insert(mb as usize, b);
            } else {
                eprintln!("warn: large fixture {} missing — skipping", path.display());
            }
        }
        Self { by_size }
    }

    pub fn get(&self, size_mb: usize) -> Option<&Vec<u8>> {
        self.by_size.get(&size_mb)
    }
}
