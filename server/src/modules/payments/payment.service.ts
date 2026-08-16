import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import connection from '../../../db/connection';
import { ConflictError, NotFoundError } from '../../errors/http-errors';
import { expenseRepository } from '../expenses/expense.repository';
import { paymentRepository, type PaymentRow } from './payment.repository';
import { residentUnitsRepository } from '../hierarchy/resident-units.repository';
import { userRepository } from '../auth/user.repository';
import {
  toPublicPayment,
  toPublicReview,
  type PaymentPublic,
  type ReviewPublic,
} from './payment.schemas';
import type { CreateActor } from '../expenses/expense.service';

/**
 * Payment service (design D3/D5; specs R3/R4).
 * Extracted to separate concerns from expense emission.
 */
export const paymentService = {
  /**
   * Resident payment report (R3/S14–S21, design Report flow). Membership:
   * active expense + `existsLink` — unknown / not-owned / soft-deleted ⇒
   * byte-identical 404 «Gasto no encontrado» (S18/S19). ONE transaction:
   * guarded expense flip `pending|rejected → under_review` (0 rows ⇒ 409 —
   * covers under_review/approved, S16/S17, and the S21 race loser) then the
   * payment insert (`status 'under_review'`); ANY failure rolls back.
   */
  async reportPayment(
    residentId: string,
    expenseId: string,
    proofUrl: string,
  ): Promise<PaymentPublic> {
    const expense = await expenseRepository.findActiveById(expenseId);
    if (!expense) {
      throw new NotFoundError('Gasto no encontrado'); // S19 (never existed or soft-deleted)
    }
    const owns = await residentUnitsRepository.existsLink(residentId, expense.unit_id);
    if (!owns) {
      throw new NotFoundError('Gasto no encontrado'); // S18 neighbor — byte-identical to S19
    }

    const id = randomUUID();
    let created: PaymentRow | undefined;
    await connection.transaction(async (trx: Knex) => {
      const affected = await expenseRepository.updateStatusGuarded(
        expenseId,
        ['pending', 'rejected'],
        'under_review',
        trx,
      );
      if (affected === 0) {
        // S16 (under_review) / S17 (approved) / S21 loser — the machine
        // rejected the transition; NOTHING was written, rollback is a no-op.
        throw new ConflictError('El gasto no admite un nuevo reporte en su estado actual');
      }
      await paymentRepository.insert(
        { id, expense_id: expenseId, resident_id: residentId, proof_url: proofUrl },
        trx,
      );
      // Read back the EXACT inserted row (by id) inside the tx so the 201
      // carries its real created_at — no "latest" ambiguity under timestamp
      // ties (design D5 tie-break only governs derived lookups).
      created = await paymentRepository.findWithCondominium(id, trx);
    });

    if (!created) {
      // Unreachable after a successful tx, kept for type narrowing.
      throw new NotFoundError('Gasto no encontrado');
    }
    return toPublicPayment(created);
  },

  /**
   * Guarded review (R4/S22–S29, design D4 — 3-step single tx). Step 0:
   * `findWithCondominium` is the source of the 404 AND the jurisdiction
   * anchor — condo_admin may only review payments in their OWN condominium,
   * otherwise byte-identical 404 «Pago no encontrado» (S24, never 403);
   * superadmin → any. Then ONE transaction, EXACTLY this order (D4):
   *   (a) guarded payment flip `under_review → decision` (0 rows ⇒ 409 —
   *       S25 re-review, S27 race loser);
   *   (b) latest-payment check — the reviewed payment MUST be the latest
   *       (`created_at DESC, id DESC`); a newer payment ⇒ 409 (S26);
   *   (c) guarded expense flip `under_review → decision` (0 rows ⇒ 409).
   * ANY failure rolls back and leaves both rows unchanged (R4/R5, S31).
   * The knex pool `min:1 max:1` serializes one better-sqlite3 connection so
   * exactly one of two concurrent reviews flips first (S27).
   */
  async review(paymentId: string, actor: CreateActor, decision: string): Promise<ReviewPublic> {
    const payment = await paymentRepository.findWithCondominium(paymentId);
    if (!payment) {
      throw new NotFoundError('Pago no encontrado'); // S29 (nonexistent or soft-deleted payment)
    }

    if (actor.role !== 'superadmin') {
      // S24: condo_admin outside their condominium ⇒ the SAME 404 body as a
      // nonexistent payment (fail-closed, never 403 — spec R4).
      const admin = await userRepository.findById(actor.id);
      if (!admin || admin.condominium_id !== payment.condominium_id) {
        throw new NotFoundError('Pago no encontrado');
      }
    }

    const expenseId = payment.expense_id;
    let updatedAt = '';
    await connection.transaction(async (trx: Knex) => {
      // (a) guarded payment flip — exactly one `under_review → decision`.
      const payFlipped = await paymentRepository.updateStatusGuarded(paymentId, decision, trx);
      if (payFlipped === 0) {
        throw new ConflictError('El pago ya fue decidido o no admite revisión'); // S25 / S27 loser
      }
      // (b) latest-payment check: the target MUST still be the expense's
      // latest payment (a newer report would be out of order, S26).
      const latest = await paymentRepository.latestByExpenseId(expenseId, trx);
      if (!latest || latest.id !== paymentId) {
        throw new ConflictError('Solo puede revisarse el último pago del gasto'); // S26
      }
      // (c) guarded expense flip — mirrors the payment decision (R5).
      const expFlipped = await expenseRepository.updateStatusGuarded(
        expenseId,
        ['under_review'],
        decision,
        trx,
      );
      if (expFlipped === 0) {
        throw new ConflictError('El gasto no admite revisión en su estado actual'); // S31 edge
      }
      const updated = await paymentRepository.findWithCondominium(paymentId, trx);
      updatedAt = updated?.updated_at ?? '';
    });

    return toPublicReview(paymentId, decision, expenseId, decision, updatedAt);
  },
};
