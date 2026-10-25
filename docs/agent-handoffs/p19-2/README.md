# P19.2 cloud-agent handoff

Fetch the exact deployed-source snapshot as a Git bundle:

```bash
git clone https://github.com/sxntaxis/subwave.git
cd subwave
git switch --track origin/handoff/p19-2-cloud-bundle
cd docs/agent-handoffs/p19-2
git bundle verify SUBWAVE_P19_2_DEPLOYED_SOURCE.bundle
git clone SUBWAVE_P19_2_DEPLOYED_SOURCE.bundle p19-2-source
```

The bundle branch is a source snapshot (`deployed-p19-2`), not a merge-ready application commit. Read `P19_CLOUD_AGENT_CONTEXT.md` first. Verify the artifact with `sha256sum -c SHA256SUMS.txt` from this directory.

Owner-supplied Di Grotesk font binaries and runtime/private data are intentionally excluded.
