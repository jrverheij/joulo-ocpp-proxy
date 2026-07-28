# Workspace Rules

## Git Up-to-Date Verification
- **Rule**: Before starting any new development task, modifying code, or creating a plan, always check if the local git repository is up-to-date with both `origin` and `upstream`.
- **Reasoning**: We have added the `upstream` remote (`https://github.com/joulo-nl/joulo-ocpp-proxy.git`) in addition to `origin`. We must ensure we are aligned with the correct branch state and have fetched the latest commits before making changes.
- **Action**: Run `git status`, `git fetch origin`, and check for any local/remote drift before starting work.
