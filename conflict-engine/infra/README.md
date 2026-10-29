# Infrastructure & access control

## Least-privilege runtime policy

`iam-policy.json` is the permission set the INTERLOCK runtime actually needs.

**It is deliberately narrower than what this project was built with.** Development ran under an existing admin user because that was fastest, and that is a normal thing to do and a bad thing to ship. The policy here is what the runtime should hold in production, and the gap between the two is stated rather than hidden — *Product Readiness* asks what happens when things go wrong, and an over-privileged agent is one of the ways they go wrong.

### What it grants

| Permission | Scope |
|---|---|
| `bedrock:InvokeModel` | **Four specific model ARNs**, not `*`. An agent that can only call the models it was designed around cannot quietly start invoking something more expensive |
| Model catalogue reads | Needed by the preflight probe to fail fast when access is missing |
| `s3:PutObject` / `GetObject` | One prefix — `adjudications/*` — in one bucket |
| `cloudwatch:PutMetricData` | Conditioned on the `INTERLOCK` namespace, so the agent cannot pollute other teams' metrics |

### What it explicitly denies

Two `Deny` statements, because an allow-list that merely omits something is weaker than a deny that forbids it — a later, broader policy attached to the same principal can widen an omission, but cannot override an explicit deny.

- **`NeverDeleteEvidence`** — adjudication records are the audit trail for automated decisions. The process that writes them must not be able to remove them. If a ruling was wrong, the correct response is another record, never a quieter history.
- **`NeverTouchTheModelAccessConfiguration`** — the runtime cannot grant itself access to new models or disable its own invocation logging.

### Applying it

```bash
aws iam create-policy \
  --policy-name interlock-runtime \
  --policy-document file://infra/iam-policy.json

aws iam create-role \
  --role-name interlock-runtime \
  --assume-role-policy-document file://infra/trust-policy.json

aws iam attach-role-policy \
  --role-name interlock-runtime \
  --policy-arn arn:aws:iam::957325809861:policy/interlock-runtime
```

Then drop `AWS_PROFILE` from `.env.local` and let the ECS task or Lambda assume the role — no long-lived keys anywhere.

---

## Hosting

The landing page is a **static export** behind CloudFront, with the S3 origin kept **private** via Origin Access Control. The bucket has no public policy; only the distribution can read it.

That shape was chosen for the judging window specifically: submissions must stay reachable and free from submission until judging closes weeks later, and a static bundle on a CDN is the deployment least likely to be quietly broken by then. Nothing to keep running, nothing to patch, nothing to fall over.

`scripts/deploy.js` rebuilds, syncs and invalidates in one command.

---

## Credential handling

Two credentials were exposed in a development transcript and both were dealt with:

- **SQL password** — rotated by `npm run rotate`, verified by reconnecting with the new one
- **`CCLOUD_API_KEY`** — must be rotated by hand; key material is shown only once at creation, so no automated flow can capture a replacement

The `.gitignore` rule that protects them was itself wrong at one point: it enumerated `.env`, `.env.local` and `.env*.local`, which looked thorough and did not match `.env.local.bak` — a file the rotation script creates, containing the password being rotated away from. It is now `.env*` with `!.env.example` re-admitted. Enumerating the good cases is the wrong shape for a secrets rule.
