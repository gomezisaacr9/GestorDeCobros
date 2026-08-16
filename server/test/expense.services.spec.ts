import { describe, expect, it, vi } from 'vitest';
import { expenseService } from '../src/modules/expenses/expense.service';
import { expenseRepository } from '../src/modules/expenses/expense.repository';

vi.mock('../src/modules/expenses/expense.repository', () => ({
  expenseRepository: {
    findActiveById: vi.fn(),
    updateStatusGuarded: vi.fn(),
  },
}));

describe('ExpenseService', () => {
  it('should getExpenseById', async () => {
    const dummyTrx = {} as any;
    vi.mocked(expenseRepository.findActiveById).mockResolvedValueOnce({ id: 'ex1' } as any);
    const res = await expenseService.getExpenseById('ex1', dummyTrx);
    expect(expenseRepository.findActiveById).toHaveBeenCalledWith('ex1', dummyTrx);
    expect(res?.id).toBe('ex1');
  });

  it('should updateExpenseStatus', async () => {
    const dummyTrx = {} as any;
    vi.mocked(expenseRepository.updateStatusGuarded).mockResolvedValueOnce(1);
    const res = await expenseService.updateExpenseStatus('ex1', ['pending'], 'approved', dummyTrx);
    expect(expenseRepository.updateStatusGuarded).toHaveBeenCalledWith('ex1', ['pending'], 'approved', dummyTrx);
    expect(res).toBe(1);
  });
});
