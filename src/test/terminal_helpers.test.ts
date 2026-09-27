import { test, describe, assert } from 'vitest';

import {
	format_terminal_command,
	parse_terminal_command,
	TerminalOutputBuffer
} from '$lib/terminal_helpers.ts';

describe('TerminalOutputBuffer', () => {
	test('concatenates chunks under the cap', () => {
		const buffer = new TerminalOutputBuffer(10);
		buffer.push('abc');
		buffer.push('');
		buffer.push('def');
		assert.strictEqual(buffer.text, 'abcdef');
		assert.strictEqual(buffer.length, 6);
		assert.ok(!buffer.dropped);
	});

	test('drops whole oldest chunks past the cap', () => {
		const buffer = new TerminalOutputBuffer(6);
		buffer.push('abc');
		buffer.push('def');
		buffer.push('ghi');
		assert.strictEqual(buffer.text, 'defghi');
		assert.strictEqual(buffer.length, 6);
		assert.ok(buffer.dropped);
	});

	test('trims a partially dropped chunk after its next newline', () => {
		const buffer = new TerminalOutputBuffer(8);
		buffer.push('ab\ncd\nef');
		buffer.push('ghi');
		// dropping 3 would start at `cd`'s line
		assert.strictEqual(buffer.text, 'cd\nefghi');
		buffer.push('j');
		// dropping 1 more would start mid-line, so it drops through the next newline
		assert.strictEqual(buffer.text, 'efghij');
		assert.strictEqual(buffer.length, 6);
		assert.ok(buffer.dropped);
	});

	test('drops a whole chunk with no newline past the trim point', () => {
		const buffer = new TerminalOutputBuffer(6);
		buffer.push('\x1b[31mred');
		buffer.push('xyz');
		assert.strictEqual(buffer.text, 'xyz');
	});

	test('never starts mid-escape when lines are available', () => {
		const buffer = new TerminalOutputBuffer(12);
		buffer.push('\x1b[1;31mone\r\n\x1b[0mtwo\r\n');
		assert.ok(buffer.text.startsWith('\x1b[0m'), JSON.stringify(buffer.text));
	});

	test('stays bounded across many pushes', () => {
		const buffer = new TerminalOutputBuffer(100);
		for (let i = 0; i < 1000; i++) buffer.push('x'.repeat(7));
		// whole chunks drop when there's no newline to cut at
		assert.isAtMost(buffer.length, 100);
		assert.isAbove(buffer.length, 100 - 7);
		assert.strictEqual(buffer.text.length, buffer.length);
	});

	test('reading text does not merge chunks into one that trims all at once', () => {
		const buffer = new TerminalOutputBuffer(100);
		for (let i = 0; i < 9; i++) buffer.push('x'.repeat(10)); // no newlines, like a progress bar
		assert.strictEqual(buffer.text.length, 90);
		buffer.push('y'.repeat(20));
		assert.strictEqual(buffer.length, 100);
		assert.strictEqual(buffer.text, 'x'.repeat(80) + 'y'.repeat(20));
	});

	test('mark_dropped sets the dropped flag', () => {
		const buffer = new TerminalOutputBuffer(10);
		buffer.push('abc');
		assert.ok(!buffer.dropped);
		buffer.mark_dropped();
		assert.ok(buffer.dropped);
	});

	test('clear resets content and the dropped flag', () => {
		const buffer = new TerminalOutputBuffer(2);
		buffer.push('abc');
		buffer.clear();
		assert.strictEqual(buffer.text, '');
		assert.strictEqual(buffer.length, 0);
		assert.ok(!buffer.dropped);
	});
});

describe('terminal commands', () => {
	test('format_terminal_command joins args', () => {
		assert.strictEqual(format_terminal_command('gro', ['check']), 'gro check');
		assert.strictEqual(format_terminal_command('ls', []), 'ls');
	});

	test('format_terminal_command joins word args with spaces', () => {
		assert.strictEqual(format_terminal_command('echo', ['a', 'b']), 'echo a b');
	});

	test('format_terminal_command keeps the leading whitespace of an arg', () => {
		assert.strictEqual(format_terminal_command('echo', ['\t a']), 'echo\t a');
	});

	test('parse_terminal_command splits off the first word, keeping the rest verbatim', () => {
		assert.deepEqual(parse_terminal_command('  echo  hello world '), {
			command: 'echo',
			args: ['  hello world']
		});
		assert.deepEqual(parse_terminal_command('ls'), { command: 'ls', args: [] });
		assert.isNull(parse_terminal_command('   '));
		assert.isNull(parse_terminal_command(''));
	});

	// the line the shell is typed is the trimmed line, byte for byte
	const verbatim_cases: Array<[string, string]> = [
		["echo ok # don't", 'echo'],
		['echo "$(printf "%s" "a  b")"', 'echo'],
		['echo "a  b"', 'echo'],
		["echo 'a  b'", 'echo'],
		['echo "say \\"hi  there\\""', 'echo'],
		['echo "unterminated  quote', 'echo'],
		['echo\t"a\tb"\t\tc', 'echo'],
		['"my  cmd"  x', '"my'],
		['"my\tcmd"', '"my'],
		['ls | grep  $HOME', 'ls'],
		['  gro check \n', 'gro']
	];
	for (const [line, command] of verbatim_cases) {
		test(`parse_terminal_command round-trips ${JSON.stringify(line)}`, () => {
			const parsed = parse_terminal_command(line);
			assert.ok(parsed);
			assert.strictEqual(parsed.command, command);
			assert.strictEqual(format_terminal_command(parsed.command, parsed.args), line.trim());
		});
	}
});
