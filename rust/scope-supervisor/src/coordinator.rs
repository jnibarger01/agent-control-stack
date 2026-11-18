use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Signal {
    Term,
    Kill,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Trigger {
    Cancelled,
    Timeout,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Event {
    Cancel {},
    DeadlineElapsed {},
    GraceElapsed {},
    LauncherClosed {},
    ScopeSignalCompleted { signal: Signal, failed: bool },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Effect {
    SignalScope {
        signal: Signal,
    },
    SignalLauncher {
        signal: Signal,
    },
    ArmGrace,
    ClearTimers,
    Finish {
        trigger: Option<Trigger>,
        signal_failed: bool,
    },
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    #[default]
    Running,
    SignalPending(Signal),
    Grace,
    Escalated,
    Closing(Signal),
    Finished,
}

#[derive(Default)]
pub(crate) struct Coordinator {
    pub(crate) phase: Phase,
    trigger: Option<Trigger>,
    signal_failed: bool,
}

impl Coordinator {
    pub(crate) fn advance(&mut self, event: Event) -> Option<Vec<Effect>> {
        let effects = match (self.phase, event) {
            (Phase::Finished, _) => return None,
            (Phase::Running, Event::Cancel {}) => self.start(Trigger::Cancelled),
            (Phase::Running, Event::DeadlineElapsed {}) => self.start(Trigger::Timeout),
            (_, Event::Cancel {} | Event::DeadlineElapsed {}) => Vec::new(),
            (Phase::Grace, Event::GraceElapsed {}) => {
                self.phase = Phase::SignalPending(Signal::Kill);
                vec![Effect::SignalScope {
                    signal: Signal::Kill,
                }]
            }
            (Phase::SignalPending(signal), Event::LauncherClosed {}) => {
                self.phase = Phase::Closing(signal);
                vec![Effect::ClearTimers]
            }
            (Phase::Running | Phase::Grace | Phase::Escalated, Event::LauncherClosed {}) => {
                vec![Effect::ClearTimers, self.finish()]
            }
            (Phase::Closing(expected), Event::ScopeSignalCompleted { signal, failed })
                if expected == signal =>
            {
                self.signal_failed |= failed;
                vec![self.finish()]
            }
            (Phase::SignalPending(expected), Event::ScopeSignalCompleted { signal, failed })
                if expected == signal =>
            {
                self.signal_failed |= failed;
                match signal {
                    Signal::Term => {
                        self.phase = Phase::Grace;
                        vec![Effect::SignalLauncher { signal }, Effect::ArmGrace]
                    }
                    Signal::Kill => {
                        self.phase = Phase::Escalated;
                        vec![Effect::SignalLauncher { signal }]
                    }
                }
            }
            _ => return None,
        };
        Some(effects)
    }

    pub(crate) fn trigger(&self) -> Option<Trigger> {
        self.trigger
    }

    fn start(&mut self, trigger: Trigger) -> Vec<Effect> {
        self.trigger = Some(trigger);
        self.phase = Phase::SignalPending(Signal::Term);
        vec![Effect::SignalScope {
            signal: Signal::Term,
        }]
    }

    fn finish(&mut self) -> Effect {
        self.phase = Phase::Finished;
        Effect::Finish {
            trigger: self.trigger,
            signal_failed: self.signal_failed,
        }
    }
}
