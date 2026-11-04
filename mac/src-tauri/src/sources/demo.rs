//! A few made-up agents, for working on the office without real agents running. Turned on by
//! setting OFFICESIM_DEMO=1.

use super::Source;
use crate::model::{ActivityKind, Agent, LastRun};

pub const ID: &str = "demo";

pub struct Demo;

impl Source for Demo {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        "Demo agents"
    }

    fn location(&self) -> String {
        "OFFICESIM_DEMO=1".into()
    }

    fn detect(&self) -> bool {
        std::env::var("OFFICESIM_DEMO").is_ok_and(|value| value == "1")
    }

    fn agents(&self) -> Vec<Agent> {
        [
            ("demo-builder", "Demo Builder", true, "Scaffolding the Mac app"),
            ("demo-reviewer", "Demo Reviewer", true, "Reviewing the adapter trait"),
            ("demo-writer", "Demo Writer", false, "Wrote the release notes"),
        ]
        .into_iter()
        .map(|(id, name, working, summary)| Agent {
            id: id.into(),
            name: name.into(),
            status: if working { "running" } else { "idle" }.into(),
            activity_kind: if working { ActivityKind::Coding } else { ActivityKind::Idle },
            last_run: Some(LastRun {
                run_id: format!("{id}-run"),
                status: if working { "running" } else { "succeeded" }.into(),
                active: working,
                summary: Some(summary.into()),
                ..LastRun::default()
            }),
            source: ID,
            ..Agent::default()
        })
        .collect()
    }
}
