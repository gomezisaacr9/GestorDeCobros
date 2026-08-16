import { describe, expect, it, vi } from 'vitest';
import { residentUnitService } from '../src/modules/hierarchy/resident-unit.service';
import { residentUnitsRepository } from '../src/modules/hierarchy/resident-units.repository';

vi.mock('../src/modules/hierarchy/resident-units.repository', () => ({
  residentUnitsRepository: {
    linkIfAbsent: vi.fn(),
    listUnitIdsByUser: vi.fn(),
  },
}));

describe('ResidentUnitService', () => {
  it('should delegate linkResidentToUnit and pass trx', async () => {
    const dummyTrx = {} as any;
    await residentUnitService.linkResidentToUnit('u1', 'unit1', dummyTrx);
    expect(residentUnitsRepository.linkIfAbsent).toHaveBeenCalledWith('u1', 'unit1', dummyTrx);
  });

  it('should delegate getUserUnitIds and pass trx', async () => {
    const dummyTrx = {} as any;
    vi.mocked(residentUnitsRepository.listUnitIdsByUser).mockResolvedValueOnce(['unit1', 'unit2']);
    
    const ids = await residentUnitService.getUserUnitIds('u1', dummyTrx);
    
    expect(residentUnitsRepository.listUnitIdsByUser).toHaveBeenCalledWith('u1', dummyTrx);
    expect(ids).toEqual(['unit1', 'unit2']);
  });
});
