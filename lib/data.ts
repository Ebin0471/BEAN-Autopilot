import type {
  ActivityItem,
  Agent,
  ConnectionSurface,
  NavItem,
  WorkflowNode,
  WorkspaceKind,
} from "./types";

/* ============================================================
   DEMONSTRATION DATA
   ------------------------------------------------------------
   Every item in this file is UI demonstration content for the
   UI-01 frontend milestone. It is NOT live data, NOT a model
   response, and NOT proof of any backend integration. Agent
   contracts, capabilities and permissions shown here are
   placeholders pending the versioned agent-contract import.
   ============================================================ */

export const WORKSPACES: { id: WorkspaceKind; label: string; blurb: string }[] = [
  { id: "personal", label: "Personal", blurb: "Life, home and personal tasks" },
  { id: "professional", label: "Professional", blurb: "Career and professional work" },
  { id: "business", label: "Business", blurb: "Tenant operations and team" },
];

export const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "Home", href: "/", icon: "home" },
  { key: "chat", label: "Chat", href: "/chat", icon: "chat" },
  { key: "agents", label: "Agent Workforce", href: "/agents", icon: "agents" },
  { key: "automation", label: "Automation Studio", href: "/automation", icon: "automation" },
  { key: "connections", label: "Connections", href: "/connections", icon: "connections" },
  { key: "activity", label: "Activity & Receipts", href: "/activity", icon: "activity" },
  { key: "files", label: "Files & Knowledge", href: "/files", icon: "files" },
  { key: "settings", label: "Settings", href: "/settings", icon: "settings" },
];

export const WORKSPACE_LABEL: Record<WorkspaceKind, string> = {
  personal: "Personal",
  professional: "Professional",
  business: "Business",
};

/**
 * Representative documented agent roster, drawn from the master mind map.
 * ALL are status "planned": the versioned contracts have not been imported
 * and no agent runtime exists. This is not the full 117-agent catalogue.
 */
export const AGENTS: Agent[] = [
  // universal
  { id: "chief-of-staff", name: "Chief of Staff", category: "universal", oneLiner: "Orchestrates and coordinates multi-step plans.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Chat", "Calendar"] },
  { id: "personal-assistant", name: "Personal Assistant", category: "universal", oneLiner: "General daily-task coordination.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Chat"] },
  { id: "research", name: "Research & Fact Checking", category: "universal", oneLiner: "Sourced research with verification.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Browser"] },
  { id: "planner", name: "Planner", category: "universal", oneLiner: "Structures goals into step plans.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "communications", name: "Communications", category: "universal", oneLiner: "Drafts and routes messages.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Email"] },
  { id: "documents", name: "Documents & Knowledge", category: "universal", oneLiner: "Organises documents and memory.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Files"] },
  { id: "meetings", name: "Meetings", category: "universal", oneLiner: "Captures and summarises meetings.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Calendar"] },
  { id: "finance-organiser", name: "Finance Organiser", category: "universal", oneLiner: "Tracks and organises personal finance.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Email"] },
  { id: "learning-coach", name: "Learning Coach", category: "universal", oneLiner: "Builds and tracks learning plans.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "wellbeing-coach", name: "Wellbeing Coach", category: "universal", oneLiner: "Wellbeing planning and reminders.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "travel-planner", name: "Travel Planner", category: "universal", oneLiner: "Plans trips and itineraries.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Browser"] },
  { id: "shopping", name: "Shopping Assistant", category: "universal", oneLiner: "Drafts shopping lists and purchases.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Browser"] },
  { id: "home-manager", name: "Home Manager", category: "universal", oneLiner: "Coordinates home and household tasks.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: [] },
  { id: "accessibility", name: "Accessibility", category: "universal", oneLiner: "Adapts interaction for accessibility.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "security-privacy", name: "Security & Privacy", category: "universal", oneLiner: "Privacy and security guidance.", status: "planned", riskClass: "R1", approval: "Within scope", connections: [] },
  { id: "automation-designer", name: "Automation Designer", category: "universal", oneLiner: "Designs automation workflows.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Automation Studio"] },
  { id: "data-analyst", name: "Data Analyst", category: "universal", oneLiner: "Analyses data and reports.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Files"] },
  { id: "translator", name: "Translator", category: "universal", oneLiner: "Tamil, Tanglish and English translation.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "customer-support", name: "Customer Support", category: "universal", oneLiner: "Support-style drafting and routing.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Email"] },
  { id: "quality-auditor", name: "Quality Auditor", category: "universal", oneLiner: "Reviews outputs for quality.", status: "planned", riskClass: "R1", approval: "Within scope", connections: [] },

  // personal
  { id: "family-coordinator", name: "Family Coordinator", category: "personal", oneLiner: "Coordinates family schedules.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Calendar"] },
  { id: "parenting", name: "Parenting Organiser", category: "personal", oneLiner: "Parenting plans and reminders.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "career-coach", name: "Career Coach", category: "personal", oneLiner: "Career planning and guidance.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "job-search", name: "Job Search", category: "personal", oneLiner: "Tracks job applications.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Browser"] },
  { id: "creator-manager", name: "Creator Manager", category: "personal", oneLiner: "Manages creator content.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Browser"] },
  { id: "personal-archive", name: "Personal Archive", category: "personal", oneLiner: "Personal memory and archive.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Files"] },
  { id: "fitness", name: "Fitness Organiser", category: "personal", oneLiner: "Fitness scheduling and tracking.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "meal-planner", name: "Meal Planner", category: "personal", oneLiner: "Meal planning and lists.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },
  { id: "pet-care", name: "Pet Care", category: "personal", oneLiner: "Pet care reminders and plans.", status: "planned", riskClass: "R0", approval: "Not required", connections: [] },

  // professional
  { id: "editor", name: "Editor", category: "professional", oneLiner: "Editing and proofreading work.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Files"] },
  { id: "graphic-designer", name: "Graphic Designer", category: "professional", oneLiner: "Design asset drafting and review.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },
  { id: "uiux", name: "UI/UX Designer", category: "professional", oneLiner: "Interface and flow design.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },
  { id: "software-developer", name: "Software Developer", category: "professional", oneLiner: "Code and engineering tasks.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Files"] },
  { id: "qa-engineer", name: "QA Engineer", category: "professional", oneLiner: "Testing and quality checks.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },
  { id: "devops", name: "DevOps Engineer", category: "professional", oneLiner: "Build and deployment support.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "data-scientist", name: "Data Scientist", category: "professional", oneLiner: "Modelling and analysis.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },
  { id: "teacher", name: "Teacher", category: "professional", oneLiner: "Lesson and materials support.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Files"] },
  { id: "academic-researcher", name: "Academic Researcher", category: "professional", oneLiner: "Literature and research support.", status: "planned", riskClass: "R1", approval: "Within scope", connections: ["Browser"] },
  { id: "healthcare-admin", name: "Healthcare Administration", category: "professional", oneLiner: "Administrative support only.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "legal-research", name: "Legal Research", category: "professional", oneLiner: "Research support, not legal advice.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Browser"] },
  { id: "accountant", name: "Accountant", category: "professional", oneLiner: "Bookkeeping support, not certified advice.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "architect", name: "Architect", category: "professional", oneLiner: "Design documentation support.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "hr-professional", name: "HR Professional", category: "professional", oneLiner: "HR administrative support.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "marketing-professional", name: "Marketing Professional", category: "professional", oneLiner: "Marketing planning and drafts.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Email"] },
  { id: "sales-professional", name: "Sales Professional", category: "professional", oneLiner: "Sales pipeline support.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["CRM"] },
  { id: "consultant", name: "Consultant", category: "professional", oneLiner: "Analysis and advisory drafts.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },

  // business
  { id: "owner-cos", name: "Owner Chief of Staff", category: "business", oneLiner: "Business-wide coordination.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Chat"] },
  { id: "operations", name: "Operations", category: "business", oneLiner: "Operational workflow support.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },
  { id: "accounting", name: "Accounting & Bookkeeping", category: "business", oneLiner: "Bookkeeping support, not certified advice.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "invoicing", name: "Invoicing", category: "business", oneLiner: "Invoice drafting and tracking.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Email"] },
  { id: "payroll", name: "Payroll Preparation", category: "business", oneLiner: "Payroll preparation support.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "tax", name: "Tax Preparation Coordination", category: "business", oneLiner: "Tax document coordination.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "crm", name: "CRM", category: "business", oneLiner: "Customer relationship support.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["CRM"] },
  { id: "customer-success", name: "Customer Success", category: "business", oneLiner: "Customer success support.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Email"] },
  { id: "sales-ops", name: "Sales Operations", category: "business", oneLiner: "Sales operations support.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["CRM"] },
  { id: "marketing-ops", name: "Marketing Operations", category: "business", oneLiner: "Marketing operations support.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Email"] },
  { id: "social-media", name: "Social Media", category: "business", oneLiner: "Social content drafting.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Browser"] },
  { id: "ecommerce", name: "E-commerce", category: "business", oneLiner: "Store operations support.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Browser"] },
  { id: "inventory", name: "Inventory", category: "business", oneLiner: "Inventory tracking support.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },
  { id: "procurement", name: "Procurement", category: "business", oneLiner: "Procurement drafting and tracking.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Files"] },
  { id: "supply-chain", name: "Supply Chain", category: "business", oneLiner: "Supply chain coordination.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Files"] },
  { id: "project-management", name: "Project Management", category: "business", oneLiner: "Project planning and tracking.", status: "planned", riskClass: "R2", approval: "Standing permission", connections: ["Files"] },
  { id: "contracts", name: "Contracts", category: "business", oneLiner: "Contract document support.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "compliance", name: "Compliance", category: "business", oneLiner: "Compliance documentation support.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "risk", name: "Risk", category: "business", oneLiner: "Risk assessment support.", status: "planned", riskClass: "R4", approval: "Human expert sign-off", connections: ["Files"] },
  { id: "it-helpdesk", name: "IT Helpdesk", category: "business", oneLiner: "IT support triage.", status: "planned", riskClass: "R3", approval: "Explicit approval", connections: ["Files"] },
];

export const CONNECTIONS: ConnectionSurface[] = [
  { id: "browser", name: "Browser", icon: "browser", state: "not-connected", note: "Planned integration surface — not connected" },
  { id: "windows", name: "Windows", icon: "windows", state: "not-connected", note: "Planned companion — not connected" },
  { id: "android", name: "Android", icon: "android", state: "not-connected", note: "Planned companion — not connected" },
  { id: "ios", name: "iOS", icon: "ios", state: "not-connected", note: "Planned companion — not connected" },
  { id: "email", name: "Email", icon: "email", state: "not-connected", note: "Planned connector — not connected" },
  { id: "calendar", name: "Calendar", icon: "calendar", state: "not-connected", note: "Planned connector — not connected" },
  { id: "business-software", name: "Business Software", icon: "apps", state: "not-connected", note: "Planned vertical connectors — not connected" },
  { id: "iot", name: "IoT", icon: "iot", state: "not-connected", note: "Planned device integration — not connected" },
];

export const ACTIVITY: ActivityItem[] = [
  { id: "a1", time: "09:12", task: "Summarise meeting notes", agent: "meetings", command: "documents.summarise", approval: "not-required", state: "success", evidence: "Demo — no real execution" },
  { id: "a2", time: "09:04", task: "Draft invoice for client", agent: "invoicing", command: "invoicing.draft", approval: "requested", state: "pending", evidence: "Awaiting explicit approval" },
  { id: "a3", time: "08:47", task: "Research travel options", agent: "travel-planner", command: "research.query", approval: "not-required", state: "success", evidence: "Demo — no real execution" },
  { id: "a4", time: "08:30", task: "Send weekly newsletter", agent: "communications", command: "email.send", approval: "approved", state: "queued", evidence: "Queued for execution" },
  { id: "a5", time: "08:12", task: "File expense report", agent: "finance-organiser", command: "finance.record", approval: "denied", state: "failed", evidence: "Approval denied — no action taken" },
];

export const INITIAL_WORKFLOW: WorkflowNode[] = [
  { id: "n1", kind: "trigger", title: "Scheduled · Daily 09:00", x: 60, y: 90, note: "Trigger" },
  { id: "n2", kind: "agent", title: "Research & Fact Checking", x: 320, y: 60, note: "AI agent node" },
  { id: "n3", kind: "condition", title: "Approval required?", x: 320, y: 210, note: "Condition" },
  { id: "n4", kind: "approval", title: "Request user approval", x: 600, y: 120, note: "Approval (R3)" },
  { id: "n5", kind: "action", title: "Send summary email", x: 600, y: 250, note: "Action" },
  { id: "n6", kind: "verify", title: "Verify sent state", x: 840, y: 190, note: "Verification" },
  { id: "n7", kind: "error", title: "Retry / escalate", x: 840, y: 330, note: "Error & recovery" },
];

export const SUGGESTED_ACTIONS = [
  "Plan my week from my calendar",
  "Draft a client follow-up email",
  "Research and summarise a topic",
  "Organise my files and notes",
];

export const RECENT_TASKS = [
  { id: "t1", title: "Meeting summary", state: "success" as const, time: "09:12" },
  { id: "t2", title: "Invoice draft", state: "pending" as const, time: "09:04" },
  { id: "t3", title: "Travel research", state: "success" as const, time: "08:47" },
];

export const PENDING_APPROVALS = [
  { id: "p1", task: "Send summary email to client", agent: "communications", risk: "R3" },
  { id: "p2", task: "Draft invoice for client", agent: "invoicing", risk: "R3" },
];
