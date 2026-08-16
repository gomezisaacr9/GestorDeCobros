import { describe, expect, it } from 'vitest';
import {
  AcceptSchema,
  InvitationCreateSchema,
} from '../src/modules/invitations/invitation.schemas';

/**
 * Schema contracts for invitation-onboarding (task 2.3): admin create body
 * (D-provided: `unit_id` uuid, optional int `expires_in_hours` 1..720) and
 * public accept body (email + password 8..128 + optional trimmed name).
 */

const UUID = '11111111-1111-4111-8111-111111111111';

describe('InvitationCreateSchema', () => {
  it('accepts a minimal valid body (unit_id only)', () => {
    const parsed = InvitationCreateSchema.safeParse({ unit_id: UUID });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.unit_id).toBe(UUID);
      expect(parsed.data.expires_in_hours).toBeUndefined();
    }
  });

  it('accepts expires_in_hours within bounds and keeps the value', () => {
    const low = InvitationCreateSchema.safeParse({ unit_id: UUID, expires_in_hours: 1 });
    const high = InvitationCreateSchema.safeParse({ unit_id: UUID, expires_in_hours: 720 });
    expect(low.success && low.data.expires_in_hours).toBe(1);
    expect(high.success && high.data.expires_in_hours).toBe(720);
  });

  it('rejects a non-uuid unit_id (S6)', () => {
    const parsed = InvitationCreateSchema.safeParse({ unit_id: 'not-a-uuid' });
    expect(parsed.success).toBe(false);
  });

  it('rejects expires_in_hours outside 1..720 and non-integers (S6)', () => {
    expect(InvitationCreateSchema.safeParse({ unit_id: UUID, expires_in_hours: 0 }).success).toBe(false);
    expect(InvitationCreateSchema.safeParse({ unit_id: UUID, expires_in_hours: -1 }).success).toBe(false);
    expect(InvitationCreateSchema.safeParse({ unit_id: UUID, expires_in_hours: 721 }).success).toBe(false);
    expect(InvitationCreateSchema.safeParse({ unit_id: UUID, expires_in_hours: 1.5 }).success).toBe(false);
    expect(InvitationCreateSchema.safeParse({ unit_id: UUID, expires_in_hours: '48' }).success).toBe(false);
  });
});

describe('AcceptSchema', () => {
  it('accepts email + password (8..128) with an optional name', () => {
    const withName = AcceptSchema.safeParse({
      email: 'resident@x.com',
      password: 'secret123',
      name: ' R ',
    });
    expect(withName.success).toBe(true);
    if (withName.success) {
      expect(withName.data.email).toBe('resident@x.com');
      expect(withName.data.password).toBe('secret123');
      expect(withName.data.name).toBe('R'); // trimmed
    }
    const noName = AcceptSchema.safeParse({ email: 'a@b.com', password: 'longenough' });
    expect(noName.success).toBe(true);
    if (noName.success) expect(noName.data.name).toBeUndefined();
  });

  it('rejects invalid email (S9)', () => {
    expect(AcceptSchema.safeParse({ email: 'nope', password: 'longenough' }).success).toBe(false);
  });

  it('rejects short passwords and over-long names', () => {
    expect(AcceptSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(false);
    expect(
      AcceptSchema.safeParse({ email: 'a@b.com', password: 'longenough', name: 'x'.repeat(256) }).success,
    ).toBe(false);
  });
});