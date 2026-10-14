/**
 * `tally_test_vouchers`: the audit procedures, as a tool.
 *
 * This is now a re-export barrel. The tool grew to 908 lines, split into
 * ./testVouchers/ as pure moves:
 *
 *   - population.ts  the population every test starts from, and the exclusion
 *                    accounting that says what was left out of it
 *   - run.ts         running one procedure and shaping its result
 *   - register.ts    the registration, the test list, and the description
 *
 * Every one of these procedures produces CANDIDATES FOR REVIEW. A candidate
 * presented as a finding is a false accusation, which is why the note saying so
 * travels with each candidate rather than sitting in a preamble a summary can
 * drop.
 */

export { TEST_VALUES, type TestName } from './testVouchers/population.js';
export {
  executeVoucherTest,
  type ExecutedVoucherTest,
  type ProcedureOptions,
  type VoucherTestArgs,
} from './testVouchers/run.js';
export { registerVoucherTestTools } from './testVouchers/register.js';
