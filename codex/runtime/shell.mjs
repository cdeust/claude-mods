// source: bash(1), COMMENTS, QUOTING, REDIRECTION, Here Documents; GNU Bash
// Reference Manual https://www.gnu.org/software/bash/manual/html_node/Redirections.html
// Literal token/operand recognition only. No expansion or shell evaluation.
const operators = ['&>>', '<<-', '<<<', '>>', '>|', '<>', '>&', '<&', '<<', '&>', '&&', '||', '|&', ';', '&', '|', '(', ')', '<', '>'];
const redirections = new Set(['&>>', '<<-', '<<<', '>>', '>|', '<>', '>&', '<&', '<<', '&>', '<', '>']);
const writes = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const quotes = { single: "'", double: '"', backtick: '`' };
const expansionDelimiters = new Map([['(', ')'], ['{', '}']]);
const controlPrefixes = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time', '!', '{', '}']);

class LiteralShell {
  constructor(source) {
    this.source = source; this.tokens = []; this.heredocs = []; this.at = 0;
  }
  expansion() {
    const begin = this.at;
    if (this.source[this.at] === quotes.backtick) {
      this.at++;
      while (this.at < this.source.length) {
        if (this.source[this.at] === '\\') { this.at += 2; continue; }
        if (this.source[this.at++] === quotes.backtick) return this.source.slice(begin, this.at);
      }
      throw new Error('Unclosed shell command substitution');
    }
    const close = this.source[this.at + 1] === '(' ? ')' : '}';
    const open = this.source[this.at + 1];
    this.at += 2;
    let depth = 1, quote = '';
    while (this.at < this.source.length) {
      const c = this.source[this.at++];
      if (c === '\\' && quote !== quotes.single) { this.at++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (Object.values(quotes).includes(c)) { quote = c; continue; }
      if (c === open) depth++;
      if (c === close && --depth === 0) return this.source.slice(begin, this.at);
    }
    throw new Error('Unclosed shell expansion');
  }
  word() {
    const state = { value: '', quote: '', dynamic: false, quoted: false };
    const start = this.at;
    while (this.at < this.source.length && this.wordCharacter(state)) { /* cursor advances in wordCharacter */ }
    if (state.quote) throw new Error('Unclosed shell quote');
    return { kind: 'word', value: state.value, dynamic: state.dynamic, quoted: state.quoted, start, end: this.at };
  }
  escape(state) {
    state.quoted = true;
    if (this.at + 1 === this.source.length) throw new Error('Incomplete shell escape');
    const next = this.source[this.at + 1];
    if (state.quote === quotes.double && !['$', quotes.backtick, quotes.double, '\\', '\n'].includes(next)) {
      state.value += '\\'; this.at++; return;
    }
    this.at += 2;
    if (next !== '\n') state.value += next;
  }
  quotedCharacter(state, c) {
    this.at++;
    if (c === state.quote) { state.quote = ''; return; }
    state.value += c;
    if (state.quote === quotes.double && c === '$') state.dynamic = true;
  }
  wordCharacter(state) {
    const c = this.source[this.at];
    if (state.quote === quotes.single) { this.quotedCharacter(state, c); return true; }
    if (c === '\\') { this.escape(state); return true; }
    if (c === quotes.backtick || (c === '$' && expansionDelimiters.has(this.source[this.at + 1]))) {
      state.dynamic = true; state.value += this.expansion(); return true;
    }
    if (state.quote === quotes.double) { this.quotedCharacter(state, c); return true; }
    if (c === quotes.single || c === quotes.double) { state.quote = c; state.quoted = true; this.at++; return true; }
    if (/\s/.test(c) || operators.some(op => this.source.startsWith(op, this.at))) return false;
    if (c === '$' || /[*?\[\]~]/.test(c)) state.dynamic = true;
    state.value += c; this.at++; return true;
  }
  logicalHeredocLine(doc) {
    let line = '', continuation;
    do {
      const newline = this.source.indexOf('\n', this.at), end = newline < 0 ? this.source.length : newline;
      let piece = this.source.slice(this.at, end);
      this.at = newline < 0 ? this.source.length : end + 1;
      if (doc.stripTabs) piece = piece.replace(/^\t+/, '');
      const trailing = piece.match(/\\+$/)?.[0].length ?? 0;
      continuation = !doc.quoted && trailing % 2 === 1 && newline >= 0;
      line += continuation ? piece.slice(0, -1) : piece;
    } while (continuation && this.at < this.source.length);
    return line;
  }
  skipHeredocs() {
    for (const doc of this.heredocs.splice(0)) {
      let terminated = false;
      while (this.at < this.source.length) {
        if (this.logicalHeredocLine(doc) === doc.delimiter) { terminated = true; break; }
      }
      if (!terminated) throw new Error('Unterminated shell here-document');
    }
  }
  tokenize() {
    while (this.at < this.source.length) {
      const c = this.source[this.at];
      if (c === '\\' && this.source[this.at + 1] === '\n') { this.at += 2; continue; }
      if (c === '\n') {
        if (this.delimiterFor) throw new Error('Missing here-document delimiter');
        this.tokens.push({ kind: 'operator', value: '\n', start: this.at, end: ++this.at });
        this.skipHeredocs(); continue;
      }
      if (/\s/.test(c)) { this.at++; continue; }
      if (c === '#') { while (this.at < this.source.length && this.source[this.at] !== '\n') this.at++; continue; }
      const op = operators.find(value => this.source.startsWith(value, this.at));
      if (op) {
        if (this.delimiterFor) throw new Error('Missing here-document delimiter');
        const previous = this.tokens.at(-1);
        if (redirections.has(op) && previous?.kind === 'word' && previous.end === this.at && /^(?:\d+|\{[a-zA-Z_][a-zA-Z_0-9]*\})$/.test(previous.value)) previous.kind = 'fd';
        this.tokens.push({ kind: 'operator', value: op, start: this.at, end: this.at + op.length });
        this.at += op.length;
        if (op === '<<' || op === '<<-') this.delimiterFor = op;
        continue;
      }
      const token = this.word();
      if (this.delimiterFor) {
        token.kind = 'heredoc-delimiter';
        this.heredocs.push({ delimiter: token.value, quoted: token.quoted, stripTabs: this.delimiterFor === '<<-' });
        this.delimiterFor = undefined;
      }
      this.tokens.push(token);
    }
    if (this.delimiterFor || this.heredocs.length) throw new Error('Unterminated shell here-document');
    return this.tokens;
  }
}
export const shellTokens = source => new LiteralShell(source).tokenize();

function literal(token) {
  if (!token || token.kind !== 'word') throw new Error('Missing file operand in guarded shell operation');
  if (token.dynamic) throw new Error('Cannot resolve expanded file operand in guarded shell operation');
  return token.value;
}
function executableWords(words) {
  // source: bash(1) Compound Commands and command builtin; env(1) utility argv.
  while (words[0] && ((!words[0].quoted && controlPrefixes.has(words[0].value)) || /^[a-zA-Z_][a-zA-Z_0-9]*=/.test(words[0].value))) {
    const prefix = words.shift().value;
    if (prefix === 'time' && words[0]?.value === '-p') words.shift();
  }
  const wrapper = words[0]?.value;
  if (wrapper === 'command') {
    words.shift();
    if (words[0]?.value === '--') words.shift();
    if (/^-[pVv]+$/.test(words[0]?.value ?? '')) {
      if (/[Vv]/.test(words.shift().value)) return [];
    }
    return executableWords(words);
  }
  if (wrapper === 'env') {
    words.shift();
    while (words[0]?.value.startsWith('-')) {
      const flag = words.shift().value;
      if (flag === '--') break;
      if (flag === '-u' || flag === '--unset') { if (!words.shift()) throw new Error('Missing env variable name'); continue; }
      if (!['-i', '--ignore-environment', '-'].includes(flag) && !flag.startsWith('--unset=')) return [];
    }
    return executableWords(words);
  }
  return words;
}
function inplaceOption(command, arg, next) {
  // source: sed(1) -i extension and perlrun(1) -i[extension].
  const inplace = (command === 'sed' || command === 'perl') && /^(?:-[a-zA-Z]*i|--in-place)/.test(arg);
  const consumesBackup = inplace && command === 'sed' && arg === '-i' && next?.value === '';
  return { inplace, consumesBackup };
}
function commandWrites(input) {
  // source: the supported command set is mods/cortex-guard/hooks/guard.ts
  // WRITES_FILES; operand syntax follows cp(1), mv(1), rm(1), tee(1), dd(1),
  // sed(1), perlrun(1), and GNU coreutils truncate invocation.
  const words = executableWords(input);
  const command = words.shift()?.value.split('/').at(-1);
  if (!['tee', 'cp', 'mv', 'rm', 'truncate', 'dd', 'sed', 'perl'].includes(command)) return [];
  if (command === 'dd') return words.filter(t => t.value.startsWith('of=')).map(t => {
    const path = literal(t).slice(3); if (!path) throw new Error('Missing dd output file'); return path;
  });
  let inplace = false, program = false, operands = [], options = true, target;
  for (let i = 0; i < words.length; i++) {
    const token = words[i], arg = token.value;
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') {
      const editor = inplaceOption(command, arg, words[i + 1]);
      inplace ||= editor.inplace;
      if (editor.consumesBackup) i++;
      if ((command === 'sed' || command === 'perl') && ['-e', '-f', '--expression', '--file'].includes(arg)) { if (!words[++i]) throw new Error('Missing editor program'); program = true; }
      else if ((command === 'sed' || command === 'perl') && /^-[a-zA-Z]*[ef]$/.test(arg)) { if (!words[++i]) throw new Error('Missing editor program'); program = true; }
      else if ((command === 'sed' || command === 'perl') && /^(?:-(?:e|f).+|--(?:expression|file)=)/.test(arg)) program = true;
      else if (['cp', 'mv'].includes(command) && ['-t', '--target-directory'].includes(arg)) target = literal(words[++i]);
      else if (['cp', 'mv'].includes(command) && arg.startsWith('--target-directory=')) target = literal(token).slice(arg.indexOf('=') + 1);
      else if (command === 'truncate' && ['-s', '--size', '-r', '--reference'].includes(arg)) { if (!words[++i]) throw new Error('Missing truncate option value'); }
      else if (command === 'tee' && arg === '--output-error') { /* optional value is only accepted with '=' */ }
      continue;
    }
    if ((command === 'sed' || command === 'perl') && !program) { program = true; continue; }
    operands.push(token);
  }
  if ((command === 'sed' || command === 'perl') && !inplace) return [];
  if (command === 'cp') {
    if (target !== undefined) return [target];
    if (operands.length < 2) throw new Error('Missing copy source/destination');
    return [literal(operands.at(-1))];
  }
  if (command === 'mv' && target !== undefined) return [...operands.map(literal), target];
  return operands.map(literal);
}

export function shellWritePaths(tokens) {
  const paths = [], words = [];
  const flush = () => { paths.push(...commandWrites(words.splice(0))); };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'fd' || token.kind === 'heredoc-delimiter') continue;
    if (token.kind === 'word') { words.push(token); continue; }
    if (redirections.has(token.value)) {
      const operand = tokens[++i];
      if (['<<', '<<-'].includes(token.value)) continue;
      if (writes.has(token.value)) paths.push(literal(operand));
      else if (token.value === '>&' && operand?.kind === 'word' && !/^(?:\d+-?|-)$/.test(operand.value)) paths.push(literal(operand));
      else if (!operand || operand.kind !== 'word') throw new Error('Missing shell redirection operand');
      continue;
    }
    flush();
  }
  flush();
  return paths;
}
