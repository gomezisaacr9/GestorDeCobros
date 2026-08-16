import { describe, expect, it, vi } from 'vitest';
import { jurisdictionService } from '../src/modules/hierarchy/jurisdiction.service';
import * as unitJurisdiction from '../src/modules/hierarchy/unit-jurisdiction';

vi.mock('../src/modules/hierarchy/unit-jurisdiction', () => {
  const chainQueryMock = {
    where: vi.fn().mockReturnThis(),
    first: vi.fn(),
  };
  return {
    chainQuery: vi.fn(() => chainQueryMock),
    findUnitInJurisdiction: vi.fn(),
  };
});

describe('JurisdictionService', () => {
  it('should getUnitChain', async () => {
    const dummyTrx = {} as any;
    const chainQueryMock = unitJurisdiction.chainQuery(dummyTrx as any);
    vi.mocked(chainQueryMock.first).mockResolvedValueOnce({ unit_id: 'u1' } as any);

    const res = await jurisdictionService.getUnitChain('u1', dummyTrx);

    expect(unitJurisdiction.chainQuery).toHaveBeenCalledWith(dummyTrx);
    expect(chainQueryMock.where).toHaveBeenCalledWith('units.id', 'u1');
    expect(res?.unit_id).toBe('u1');
  });

  it('should checkJurisdiction', async () => {
    const dummyTrx = {} as any;
    const admin = { id: '1', role: 'superadmin', condominium_id: null, building_id: null };
    vi.mocked(unitJurisdiction.findUnitInJurisdiction).mockResolvedValueOnce({ unit_id: 'u1' } as any);

    const res = await jurisdictionService.checkJurisdiction('u1', admin, dummyTrx);

    expect(unitJurisdiction.findUnitInJurisdiction).toHaveBeenCalledWith('u1', admin, dummyTrx);
    expect(res?.unit_id).toBe('u1');
  });
});
