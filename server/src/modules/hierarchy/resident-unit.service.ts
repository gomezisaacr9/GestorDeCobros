import type { Knex } from 'knex';
import { residentUnitsRepository } from './resident-units.repository';

export const residentUnitService = {
  async linkResidentToUnit(userId: string, unitId: string, trx?: Knex.Transaction): Promise<void> {
    await residentUnitsRepository.linkIfAbsent(userId, unitId, trx);
  },

  async getUserUnitIds(userId: string, trx?: Knex.Transaction): Promise<string[]> {
    return residentUnitsRepository.listUnitIdsByUser(userId, trx);
  }
};
