import type { ActionPassportService, Passport } from "./passport";
import type { PassportState } from "./types";

/**
 * Reusable approval service. Wraps passport approval decisions and exposes
 * pending-approval listing. Approver authority and separation of duties are
 * enforced inside the passport service.
 */
export class ApprovalService {
  constructor(private passport: ActionPassportService) {}

  listPending(workspaceId: string): Passport[] {
    return this.passport.list(workspaceId, "PENDING_APPROVAL");
  }

  getStatus(passportId: string): Passport | undefined {
    return this.passport.get(passportId);
  }

  approve(
    passportId: string,
    approverId: string,
    decision: "APPROVED" | "REJECTED",
    comment?: string,
  ): Passport {
    return this.passport.approve(passportId, approverId, decision, comment);
  }

  revoke(passportId: string, actorId: string): Passport {
    return this.passport.revoke(passportId, actorId);
  }

  listByState(workspaceId: string, state: PassportState): Passport[] {
    return this.passport.list(workspaceId, state);
  }
}
