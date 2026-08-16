import type { Knex } from 'knex';
import connection from '../../../db/connection';
import { chainQuery, findUnitInJurisdiction as findUnitRepo, type UnitChain, type AdminRow } from './unit-jurisdiction';

export const jurisdictionService = {
  async getUnitChain(unitId: string, trx?: Knex.Transaction): Promise<UnitChain | undefined> {
    const db = trx ?? connection;
    return chainQuery(db as any).where('units.id', unitId).first();
  },

  async checkJurisdiction(unitId: string, admin: AdminRow, trx?: Knex.Transaction): Promise<UnitChain | undefined> {
    const db = trx ?? connection;
    return findUnitRepo(unitId, admin, db as any);
  }
};

export type { UnitChain, AdminRow };
