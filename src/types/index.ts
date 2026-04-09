export const FIRM_ROLES = [
  'managing_attorney',
  'attorney',
  'firm_admin',
  'case_manager',
  'counselworks_admin',
  'counselworks_operator',
  'qa_reviewer',
] as const;

export type FirmRole = typeof FIRM_ROLES[number];

// These roles bypass firm-specific membership checks and can access any firm
export const CW_GLOBAL_ROLES: FirmRole[] = ['counselworks_admin'];

export interface AuthenticatedUser {
  id: string;
  authId: string;
  email: string;
  fullName: string;
}

export interface FirmContext {
  firmId: string;
  role: FirmRole;
  membershipId: string | null; // null when cw_admin bypasses membership
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      firmContext?: FirmContext;
    }
  }
}
