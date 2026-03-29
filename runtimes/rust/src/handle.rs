use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::thread;

use crate::error::{Result, XriptError};
use crate::fragment::ModInstance;
use crate::sandbox::{ExecutionResult, RuntimeOptions};

enum Command {
    Execute {
        code: String,
        tx: mpsc::Sender<Result<ExecutionResult>>,
    },
    LoadMod {
        mod_manifest_json: String,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: HashSet<String>,
        entry_source: Option<String>,
        tx: mpsc::Sender<Result<ModInstance>>,
    },
    ManifestName {
        tx: mpsc::Sender<String>,
    },
    Shutdown,
}

pub struct XriptHandle {
    cmd_tx: mpsc::Sender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}

impl XriptHandle {
    pub fn new(manifest_json: String, options: RuntimeOptions) -> Result<Self> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (init_tx, init_rx) = mpsc::channel::<Result<()>>();

        let thread = thread::spawn(move || {
            let rt = match crate::create_runtime(&manifest_json, options) {
                Ok(rt) => {
                    let _ = init_tx.send(Ok(()));
                    rt
                }
                Err(e) => {
                    let _ = init_tx.send(Err(e));
                    return;
                }
            };

            while let Ok(cmd) = cmd_rx.recv() {
                match cmd {
                    Command::Execute { code, tx } => {
                        let _ = tx.send(rt.execute(&code));
                    }
                    Command::LoadMod {
                        mod_manifest_json,
                        fragment_sources,
                        granted_capabilities,
                        entry_source,
                        tx,
                    } => {
                        let _ = tx.send(rt.load_mod(
                            &mod_manifest_json,
                            fragment_sources,
                            &granted_capabilities,
                            entry_source.as_deref(),
                        ));
                    }
                    Command::ManifestName { tx } => {
                        let _ = tx.send(rt.manifest().name.clone());
                    }
                    Command::Shutdown => break,
                }
            }
        });

        init_rx
            .recv()
            .map_err(|_| XriptError::Engine("runtime thread panicked during init".into()))??;

        Ok(Self {
            cmd_tx,
            thread: Some(thread),
        })
    }

    pub fn execute(&self, code: &str) -> Result<ExecutionResult> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::Execute {
                code: code.to_string(),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn load_mod(
        &self,
        mod_manifest_json: &str,
        fragment_sources: HashMap<String, String>,
        granted_capabilities: &HashSet<String>,
        entry_source: Option<&str>,
    ) -> Result<ModInstance> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::LoadMod {
                mod_manifest_json: mod_manifest_json.to_string(),
                fragment_sources,
                granted_capabilities: granted_capabilities.clone(),
                entry_source: entry_source.map(|s| s.to_string()),
                tx,
            })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))?
    }

    pub fn manifest_name(&self) -> Result<String> {
        let (tx, rx) = mpsc::channel();
        self.cmd_tx
            .send(Command::ManifestName { tx })
            .map_err(|_| XriptError::Engine("runtime thread is gone".into()))?;
        rx.recv()
            .map_err(|_| XriptError::Engine("runtime thread dropped response".into()))
    }
}

impl Drop for XriptHandle {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
