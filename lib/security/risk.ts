import { RISK_POLICY, type RiskClass, type RiskPolicy } from "./types";

const RANK: Record<RiskClass, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

/**
 * Central risk classifier. Risk is always determined server-side from the
 * action's command/operation. A client-supplied (proposed) risk can never
 * lower the authoritative classification: the higher of the ruleset value and
 * the proposed value is enforced.
 */
export class RiskClassifier {
  /** Map an action to its minimum authoritative risk class from a ruleset. */
  private ruleset(text: string): RiskClass {
    if (/\b(delete|destroy|drop|purge|wipe|revoke-all|format)\b/.test(text)) return "R4";
    if (/\b(send|email|message|purchase|pay|transfer|money|invoice|deploy|publish|share|disclose)\b/.test(text)) {
      return "R3";
    }
    if (/\b(read|list|get|fetch|query|view)\b/.test(text)) return "R1";
    return "R2";
  }

  classify(action: {
    command: string;
    operation: string;
    proposed?: RiskClass | null;
  }): { risk: RiskClass; policy: RiskPolicy; downgraded: boolean } {
    const text = `${action.command} ${action.operation}`.toLowerCase();
    const forced = this.ruleset(text);
    const proposed = action.proposed ?? forced;
    // Server-authoritative: never allow a client to lower risk.
    const risk: RiskClass = RANK[forced] >= RANK[proposed] ? forced : proposed;
    return {
      risk,
      policy: RISK_POLICY[risk],
      downgraded: RANK[forced] > RANK[proposed],
    };
  }

  policyFor(risk: RiskClass): RiskPolicy {
    return RISK_POLICY[risk];
  }
}
