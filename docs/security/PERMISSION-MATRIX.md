# CORE-01 Permission Matrix

Central, deny-by-default RBAC. Permissions are explicit `resource.action`
scopes. All authorisation flows through the **one** central `PolicyEngine`.

## 1. Roles

| Role | Scope | Notes |
|---|---|---|
| `OWNER` | Full control | Holds all permissions; cannot be removed while the sole owner |
| `ADMIN` | Full except owner-only | Cannot delete workspace or manage policy |
| `OPERATOR` | Operate | Read, update, files, memory, agents, actions.request, connections |
| `MEMBER` | Contribute | Read, files, memory, agents.read, actions.request |
| `VIEWER` | Read + audit | Read-only plus audit.read |

## 2. Permission scopes

| Permission | Meaning | OWNER | ADMIN | OPERATOR | MEMBER | VIEWER |
|---|---|:--:|:--:|:--:|:--:|:--:|
| `workspace.read` | View workspace + context | ✅ | ✅ | ✅ | ✅ | ✅ |
| `workspace.update` | Update workspace settings | ✅ | ✅ | ✅ | ❌ | ❌ |
| `workspace.delete` | Delete workspace (owner-only) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `workspace.members.read` | List members | ✅ | ✅ | ✅ | ✅ | ✅ |
| `workspace.members.invite` | Invite members | ✅ | ✅ | ❌ | ❌ | ❌ |
| `workspace.members.manage` | Change/remove member roles | ✅ | ✅ | ❌ | ❌ | ❌ |
| `policy.manage` | Manage workspace policy (owner-only) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `files.read` | Read files | ✅ | ✅ | ✅ | ✅ | ✅ |
| `files.write` | Write/edit files | ✅ | ✅ | ✅ | ✅ | ❌ |
| `memory.read` | Read memory | ✅ | ✅ | ✅ | ✅ | ✅ |
| `memory.write` | Write memory | ✅ | ✅ | ✅ | ✅ | ❌ |
| `agents.read` | View agents | ✅ | ✅ | ✅ | ✅ | ✅ |
| `agents.configure` | Configure agents | ✅ | ✅ | ✅ | ❌ | ❌ |
| `actions.request` | Create an action request / passport | ✅ | ✅ | ✅ | ✅ | ❌ |
| `actions.approve` | Approve/reject a passport | ✅ | ✅ | ✅ | ❌ | ❌ |
| `actions.execute` | Authorise/execute an action | ✅ | ✅ | ✅ | ❌ | ❌ |
| `connections.manage` | Manage integrations | ✅ | ✅ | ✅ | ❌ | ❌ |
| `audit.read` | Read audit history | ✅ | ✅ | ✅ | ✅ | ✅ |

## 3. Principles

- **Deny-by-default:** an unknown permission, missing membership, or missing grant
  always denies.
- **Least privilege:** grants are explicit; ADMIN is deliberately withheld
  `workspace.delete` and `policy.manage`.
- **Server-enforced:** roles are resolved from the server-side membership only.
  Client-supplied roles are ignored.
- **Owner protection:** the final owner cannot be removed; owner-only controls
  are reserved.
- **Separation of duties:** an approver cannot be the initiator of the action
  they approve; R4 dual approval requires two distinct approvers.
- **No self-granting:** a principal cannot grant themselves a role they do not
  hold.

## 4. Risk classifier (server-authoritative)

| Class | Meaning | Approval | Autonomous execution | Dual approval |
|---|---|:--:|:--:|:--:|
| R0 | Local draft | No | Allowed | — |
| R1 | Read-only | No (read permission) | Allowed | — |
| R2 | Low-risk reversible | No (scoped permission; passport records) | Allowed | — |
| R3 | Consequential | **Required** (human; no silent autonomous) | Blocked | Supported |
| R4 | Destructive / safety-critical / regulated / production | **Required** (human-only) | Blocked | Required where configured |

**Clients can never lower the class.** The server classifies from the
command/operation; any client-proposed risk is ignored.

## 5. Where enforcement lives

- `lib/security/policy.ts` — `PolicyEngine` (central, deny-by-default)
- `lib/security/permissions.ts` — role→permission mapping + effective permissions
- `lib/security/risk.ts` — `RiskClassifier` (server-authoritative)
- `lib/security/passport.ts` — scope bounding + approval gate

No authorisation decision is made in React components or route handlers directly;
they all call the central policy service.
