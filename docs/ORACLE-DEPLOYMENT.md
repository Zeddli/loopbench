# Oracle Always Free deployment

Status: preparation only. No Oracle account or VM has been created, and no Linux ARM deployment has been verified. The existing local Token Factory campaign is paused. This guide keeps the current single-host SQLite architecture.

## Create the account

The account owner completes [Oracle Cloud Free Tier signup](https://www.oracle.com/cloud/free/), including identity checks, card verification and acceptance of Oracle's terms. Do not send card details, passwords or verification codes through chat. Oracle describes temporary card authorization holds in its [signup FAQ](https://www.oracle.com/cloud/free/faq/).

Choose the home region carefully. It [cannot be changed after account creation](https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/managingregions.htm), and Always Free compute must be created there. A nearby region offered during signup is a reasonable first choice, but available capacity cannot be established before provisioning. Do not upgrade to a paid plan merely to follow this guide.

## Select the VM

Verify the console's Always Free eligibility and displayed cost before creation. The current official [Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) lists this allocation:

| Setting | Target |
| --- | --- |
| Shape | VM.Standard.A1.Flex, Arm |
| CPU | 2 OCPUs |
| Memory | 12 GB |
| Image | Always Free-eligible Ubuntu ARM64, preferably 24.04 LTS if offered |
| Boot disk | 50 GB; within the account's combined free storage allowance |
| Other resources | No GPU, paid image, additional disk or paid load balancer |

Oracle currently lists 1500 OCPU-hours and 9000 GB-hours monthly for A1, plus 200 GB combined boot/block storage. Other instances and volumes consume the same allowances. Capacity shortages and idle-instance reclamation remain possible; do not manufacture CPU load to prevent reclamation. Back up the application database and its matching encryption keys independently of the VM.

After account creation, record the home region and inspect whether the requested shape is available. Keep the generated private SSH key locally. The deployment needs the VM's public address, SSH username and local key-file path, not the key contents in chat.

## Target application layout

The VM runs Next.js, one worker, one reaper and the database. Pi and fresh verifiers remain in Nebius Token Factory Sandboxes; Nemotron inference remains on Token Factory. The host needs no GPU. Hosting eligibility does not make model or sandbox usage free.

Use the existing [hosted runbook](HOSTED-RUNBOOK.md) and [systemd units](../deploy/systemd/loopbench-web.service):

- `/opt/loopbench/releases/<commit>` contains a Linux-built, commit-pinned release.
- `/opt/loopbench/current` selects that release.
- `/var/lib/loopbench` holds persistent SQLite state and private artifacts.
- `/etc/loopbench` holds protected service environments, the matching vault keyring and approved runtime manifest.
- Next listens on loopback. A configured HTTPS reverse proxy exposes the application. The domain or other stable HTTPS hostname must be chosen before enabling production admission.

Build Linux ARM dependencies on the VM with the repository lockfile. Do not upload Windows `node_modules` or `.next` output. Pin and verify a supported Node 24 patch. Run typecheck, the full tests and a production build on ARM before calling it supported. Runtime image verification for the remote Pi guests is separate from the host's architecture.

## Preserve existing evidence

1. Keep the local campaign paused; confirm no owned sandbox or active inference remains.
2. Make a consistent SQLite backup and copy the corresponding private artifacts and vault keys over authenticated SSH. Do not copy only the main file of a live WAL database. Never put this bundle in Git or a public build artifact.
3. Install a separate release of the committed source. Configure Linux absolute paths, production HTTPS origins and the approved Token Factory image manifest. Keep hosted admission disabled during preparation.
4. Preserve owner scopes, jobs, budgets, model pricing records and immutable publications. Validate credential decryption without printing keys. Changing origin or cookie mode does not transfer a user's browser session automatically; verify owner access explicitly.
5. Confirm the service user can read the release and manifest, write the database/artifact directories, and use all required Next runtime cache locations under the service sandbox. Do not bypass service restrictions if a writable path is missing; configure the required path explicitly.
6. Enable the web service, run preflight and start the reaper before the worker. Verify HTTPS, private access boundaries, restart recovery, publication following and confirmed sandbox cleanup.
7. Resume an existing campaign only after its admission and remaining inference allowance have been checked. A successful deployment is separate from a measured harness improvement.

## Acceptance evidence

Record the exact source commit, Ubuntu/Node versions, ARM test/build results, HTTPS URL, persistent paths and service status. Demonstrate process restart with preserved records, an actual scoped inference request, an actual verifier result and cleanup. Then disconnect the local development worker and verify that a new checkpoint is produced by the VM alone. Only that observation establishes that the laptop may be closed without stopping evolution.
