/**
 * Build an independent, bounded CSR correctness check from a private starter at
 * runtime. The returned C++ is data: this module neither writes nor executes it.
 * The caller must put the workflow-generated candidate beside the checker under
 * the selected include name and compile the checker with OpenMP enabled.
 */

export interface CsrCheckerMetadata {
	matrixType: string;
	targets: [string, string];
	absTolerance: string;
	relTolerance: string;
	candidateInclude: string;
	threadCounts: readonly [1, 2, 4];
	shapes: readonly (readonly [number, number])[];
	mutationPasses: 2;
	timing: {
		marker: "CSR_TIMING";
		shapes: readonly (readonly [number, number])[];
		threadCounts: readonly [1, 4];
		warmups: 2;
		repeats: 16;
	};
}

export interface CsrChecker {
	source: string;
	metadata: CsrCheckerMetadata;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*$/;
const SHAPES = [[1, 1], [7, 5], [19, 23], [32, 11]] as const;
const TIMED_SHAPES = [[1024, 509], [4096, 2047]] as const;

function todoTarget(starter: string, ordinal: 1 | 2): { name: string; matrixType: string } {
	const marker = new RegExp(`\\/\\/[^\\n]*\\bTODO\\s*${ordinal}\\s*:`, "g");
	const matches = [...starter.matchAll(marker)];
	if (matches.length !== 1) throw new Error(`expected one TODO ${ordinal} marker`);
	const following = starter.slice(matches[0].index! + matches[0][0].length,
		matches[0].index! + matches[0][0].length + 1200);
	const declaration = following.match(/\b(?:static\s+)?void\s+([A-Za-z_]\w*)\s*\(\s*const\s+([A-Za-z_]\w*)\s*&/);
	if (!declaration) throw new Error(`cannot derive TODO ${ordinal} target signature`);
	return { name: declaration[1], matrixType: declaration[2] };
}

function tolerance(starter: string, name: "abs_tol" | "rel_tol"): string {
	const number = "([+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)";
	const matches = [...starter.matchAll(new RegExp(`\\b${name}\\s*=\\s*${number}\\b`, "g"))];
	if (matches.length !== 1) throw new Error(`cannot derive unique starter ${name}`);
	return matches[0][1];
}

/** The include is a basename, so generated source cannot include an arbitrary path. */
export function buildCsrChecker(starterSource: string, candidateInclude = "candidate.cpp"): CsrChecker {
	if (!/^[A-Za-z_][A-Za-z_0-9.-]*\.cpp$/.test(candidateInclude) || candidateInclude.includes(".."))
		throw new Error("candidate include must be a local C++ basename");
	const first = todoTarget(starterSource, 1);
	const second = todoTarget(starterSource, 2);
	if (first.name === second.name || first.matrixType !== second.matrixType)
		throw new Error("TODO targets must be distinct functions using the same CSR type");
	if (![first.name, second.name, first.matrixType].every(value => IDENTIFIER.test(value)))
		throw new Error("invalid derived identifier");
	if (!new RegExp(`\\bstruct\\s+${first.matrixType}\\s*\\{`).test(starterSource))
		throw new Error("derived CSR struct declaration is missing");
	const absTolerance = tolerance(starterSource, "abs_tol");
	const relTolerance = tolerance(starterSource, "rel_tol");
	const metadata: CsrCheckerMetadata = {
		matrixType: first.matrixType,
		targets: [first.name, second.name],
		absTolerance, relTolerance, candidateInclude,
		threadCounts: [1, 2, 4], shapes: SHAPES, mutationPasses: 2,
		timing: { marker: "CSR_TIMING", shapes: TIMED_SHAPES, threadCounts: [1, 4], warmups: 2, repeats: 16 },
	};
	const source = `// Generated privately from a starter; compile this file with -fopenmp.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include <omp.h>
#define main csr_check_original_main
#include "${candidateInclude}"
#undef main

static_assert(sizeof(${first.matrixType}) > 0, "derived CSR type must exist");
using CheckedTarget = void (*)(const ${first.matrixType}&, const std::vector<double>&, std::vector<double>&);

static ${first.matrixType} checker_matrix(int rows, int cols, bool timing_shape = false) {
    ${first.matrixType} matrix;
    matrix.rows = rows;
    matrix.cols = cols;
    matrix.row_ptr.assign(static_cast<std::size_t>(rows) + 1, 0);
    for (int row = 0; row < rows; ++row) {
        const int count = timing_shape ? (row % 32 == 0 ? 2048 : 32) :
            row % 7 == 0 && rows > 1 ? 0 :
            row % 5 == 0 ? 31 : 1 + (row * 3) % 6;
        for (int slot = 0; slot < count; ++slot) {
            matrix.col_idx.push_back((row * 13 + slot * 7 + slot * slot) % cols);
            matrix.values.push_back(static_cast<double>((row * 17 + slot * 11) % 29 - 14) / 13.0);
        }
        matrix.row_ptr[static_cast<std::size_t>(row) + 1] =
            static_cast<int>(matrix.values.size());
    }
    return matrix;
}

// Recomputed independently for each check, without calling any candidate helper.
static std::vector<double> checker_reference(const ${first.matrixType}& matrix,
                                             const std::vector<double>& x) {
    std::vector<double> expected(static_cast<std::size_t>(matrix.rows));
    for (int row = 0; row < matrix.rows; ++row) {
        double sum = 0.0;
        for (int p = matrix.row_ptr[row]; p < matrix.row_ptr[row + 1]; ++p) {
            sum += matrix.values[static_cast<std::size_t>(p)] *
                   x[static_cast<std::size_t>(matrix.col_idx[static_cast<std::size_t>(p)])];
        }
        expected[static_cast<std::size_t>(row)] = sum;
    }
    return expected;
}

static void checker_mutate(${first.matrixType}& matrix, std::vector<double>& x, int pass) {
    for (std::size_t p = 0; p < matrix.values.size(); ++p) {
        matrix.values[p] = pass == 1
            ? matrix.values[p] * -0.75 + static_cast<double>(static_cast<int>(p % 5) - 2) / 17.0
            : matrix.values[p] * 0.5 + static_cast<double>(static_cast<int>(p % 7) - 3) / 19.0;
    }
    for (std::size_t j = 0; j < x.size(); ++j) {
        x[j] = pass == 1
            ? x[j] * 1.25 - static_cast<double>(static_cast<int>(j % 7) - 3) / 23.0
            : -x[j] + static_cast<double>(static_cast<int>(j % 5) - 2) / 29.0;
    }
}

static void checker_run(CheckedTarget target, const char* label, int rows, int cols) {
    ${first.matrixType} matrix = checker_matrix(rows, cols);
    std::vector<double> x(static_cast<std::size_t>(cols));
    for (int col = 0; col < cols; ++col)
        x[static_cast<std::size_t>(col)] = static_cast<double>((col * 19) % 31 - 15) / 17.0;
    std::vector<double> output(static_cast<std::size_t>(rows));
    const auto* value_address = matrix.values.data();
    const auto* x_address = x.data();
    const auto* output_address = output.data();
    const auto prior_row_ptr = matrix.row_ptr;
    const auto prior_col_idx = matrix.col_idx;
    for (int pass = 0; pass != 3; ++pass) {
        if (pass != 0) checker_mutate(matrix, x, pass);
        for (int threads : {1, 2, 4}) {
            const std::vector<double> expected = checker_reference(matrix, x);
            const auto prior_values = matrix.values;
            const auto prior_x = x;
            std::fill(output.begin(), output.end(), std::numeric_limits<double>::quiet_NaN());
            omp_set_dynamic(0);
            omp_set_num_threads(threads);
            target(matrix, x, output);
            if (output.size() != static_cast<std::size_t>(rows) ||
                matrix.values.data() != value_address || x.data() != x_address ||
                output.data() != output_address || matrix.rows != rows || matrix.cols != cols ||
                matrix.row_ptr != prior_row_ptr || matrix.col_idx != prior_col_idx ||
                matrix.values != prior_values || x != prior_x)
                throw std::runtime_error(std::string(label) + ": changed input or output buffer");
            for (int row = 0; row < rows; ++row) {
                const double actual = output[static_cast<std::size_t>(row)];
                const double wanted = expected[static_cast<std::size_t>(row)];
                const double error = std::abs(wanted - actual);
                const double scale = std::max(1.0, std::abs(wanted));
                if (!std::isfinite(actual) || error > ${absTolerance} + ${relTolerance} * scale) {
                    throw std::runtime_error(std::string(label) + ": mismatch/nonfinite/unwritten row=" +
                        std::to_string(row) + " shape=" + std::to_string(rows) + "x" +
                        std::to_string(cols) + " pass=" + std::to_string(pass) +
                        " threads=" + std::to_string(threads));
                }
            }
        }
    }
}

// The host owns the data, clock, repetitions, and output record. Warm-ups,
// mutations, reference work, sentinel setup, and validation are outside timing.
static std::int64_t checker_time(CheckedTarget target, const char* label,
                                 int rows, int cols, int threads) {
    ${first.matrixType} matrix = checker_matrix(rows, cols, true);
    std::vector<double> x(static_cast<std::size_t>(cols));
    for (int col = 0; col < cols; ++col)
        x[static_cast<std::size_t>(col)] = static_cast<double>((col * 19) % 31 - 15) / 17.0;
    std::vector<double> output(static_cast<std::size_t>(rows));
    const auto* value_address = matrix.values.data();
    const auto* x_address = x.data();
    const auto* output_address = output.data();
    const auto prior_row_ptr = matrix.row_ptr;
    const auto prior_col_idx = matrix.col_idx;
    std::int64_t total_ns = 0;
    omp_set_dynamic(0);
    omp_set_num_threads(threads);
    for (int rep = -2; rep < 16; ++rep) {
        checker_mutate(matrix, x, rep % 2 == 0 ? 1 : 2);
        const std::vector<double> expected = checker_reference(matrix, x);
        const auto prior_values = matrix.values;
        const auto prior_x = x;
        std::fill(output.begin(), output.end(), std::numeric_limits<double>::quiet_NaN());
        const auto start = std::chrono::steady_clock::now();
        target(matrix, x, output);
        const auto stop = std::chrono::steady_clock::now();
        if (output.size() != static_cast<std::size_t>(rows) ||
            matrix.values.data() != value_address || x.data() != x_address ||
            output.data() != output_address || matrix.rows != rows || matrix.cols != cols ||
            matrix.row_ptr != prior_row_ptr || matrix.col_idx != prior_col_idx ||
            matrix.values != prior_values || x != prior_x)
            throw std::runtime_error(std::string(label) + ": changed input or output buffer during timing");
        for (int row = 0; row < rows; ++row) {
            const double actual = output[static_cast<std::size_t>(row)];
            const double wanted = expected[static_cast<std::size_t>(row)];
            const double error = std::abs(wanted - actual);
            const double scale = std::max(1.0, std::abs(wanted));
            if (!std::isfinite(actual) || error > ${absTolerance} + ${relTolerance} * scale)
                throw std::runtime_error(std::string(label) + ": timed mismatch row=" +
                    std::to_string(row) + " shape=" + std::to_string(rows) + "x" +
                    std::to_string(cols) + " threads=" + std::to_string(threads));
        }
        if (rep >= 0)
            total_ns += std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count();
    }
    return total_ns;
}

int main() {
    try {
        for (const auto& shape : std::vector<std::pair<int, int>>{{1, 1}, {7, 5}, {19, 23}, {32, 11}}) {
            checker_run(${first.name}, "TODO 1", shape.first, shape.second);
            checker_run(${second.name}, "TODO 2", shape.first, shape.second);
        }
        for (const auto& shape : std::vector<std::pair<int, int>>{{1024, 509}, {4096, 2047}}) {
            for (int threads : {1, 4}) {
                const auto first_ns = checker_time(${first.name}, "TODO 1", shape.first, shape.second, threads);
                std::cout << "CSR_TIMING target=1 rows=" << shape.first << " cols=" << shape.second
                          << " threads=" << threads << " repeats=16 elapsed_ns=" << first_ns << '\\n';
                const auto second_ns = checker_time(${second.name}, "TODO 2", shape.first, shape.second, threads);
                std::cout << "CSR_TIMING target=2 rows=" << shape.first << " cols=" << shape.second
                          << " threads=" << threads << " repeats=16 elapsed_ns=" << second_ns << '\\n';
            }
        }
        std::cout << "CSR_CHECK_PASS\\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\\n';
        return 1;
    }
}
`;
	return { source, metadata };
}
