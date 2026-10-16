import { expect, test } from 'claude-code/testing'

import { shellCommands } from './shell'

// The scanner's boundaries, one state each: what ends a command, what a quote, a substitution, a continuation
// and a heredoc hold, and which redirection opens a file.
const bare = (src: string) => shellCommands(src).map((c) => c.bare)
const targets = (src: string) => shellCommands(src).flatMap((c) => c.targets)

test('separators end a command where the shell reads one, never inside a quote', () => {
  expect(bare('a; b && c || d | e |& f & g\nh')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  expect(bare(`echo 'a; b' "c && d\ne" f`)).toEqual(["echo '' '' f"])
  expect(bare('(a && b) ; { c; }')).toEqual(['a', 'b', '{ c', '}'])
})

test('a continuation joins, a comment ends at its line, an escaped operator is a word', () => {
  expect(bare('git worktree add \\\n  -b x \\\n  /p')).toEqual(['git worktree add -b x /p'])
  expect(bare('gi\\\nt sta\\\ntus')).toEqual(['git status'])
  expect(bare('a # b; c\nd')).toEqual(['a', 'd'])
  expect(bare('echo a\\;b \\> c')).toEqual(['echo a_b _ c'])
  expect(bare('echo a#b')).toEqual(['echo a#b'])
})

test('a substitution runs its own commands, in or out of double quotes, nested', () => {
  expect(bare('echo $(a; b) "$(c)" `d` "`e`" $((1 + 2))')).toEqual(['a', 'b', 'c', 'd', 'e', "echo '' '' '' '' ''"])
  expect(bare('x "$(y "$(z)")"')).toEqual(['z', "y ''", "x ''"])
  expect(bare('echo $(f (g) h)')).toEqual(['f', 'g', 'h', "echo ''"])
})

test('a heredoc body is read to its terminator; only an unquoted delimiter expands it', () => {
  expect(bare("cat <<'EOF'\n$(a)\nb; c\nEOF\nd")).toEqual(['cat', 'd'])
  expect(bare('cat <<EOF\n$(a)\nb; c\nEOF\nd')).toEqual(['cat', 'a', 'd'])
  expect(bare('cat <<-EOF\n\tb\n\tEOF\nd')).toEqual(['cat', 'd'])
  // `<<` (not `<<-`) needs the terminator alone on its line: an indented one is body
  expect(bare('cat <<EOF\n\tb\n\tEOF\nd')).toEqual(['cat'])
  expect(bare('a <<X <<Y\n1\nX\n2\nY\nb')).toEqual(['a', 'b'])
  // the heredoc inside `$(` of a double-quoted argument, as a commit or a PR body is written
  expect(bare(`git commit -m "$(cat <<'EOF'\nmsg )" > f\nEOF\n)"\ngit push`)).toEqual(['cat', "git commit -m ''", 'git push'])
  // a here-string and a quoted `<<` open no heredoc
  expect(bare('cat <<< "EOF"\nb')).toEqual(['cat', 'b'])
  expect(bare('echo "<<EOF"\nb')).toEqual(["echo ''", 'b'])
})

test('an output redirection names the file it opens; a descriptor and an input are none', () => {
  expect(targets('a > f >> g &> h &>> i >| j 2> k 9>>l >&m')).toEqual(['f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'])
  expect(targets('a 2>&1 >&2 3>&- < in <<< w <& 0')).toEqual([])
  expect(targets('a > "$TMPDIR/x y" > \'q\' > ${TMPDIR}/z')).toEqual(['$TMPDIR/x y', 'q', '${TMPDIR}/z'])
  expect(targets('a <> rw')).toEqual(['rw'])
})

test('an unterminated quote, substitution or heredoc ends the text without a loop', () => {
  expect(bare(`echo 'a`)).toEqual(["echo ''"])
  expect(bare('echo "a $(b')).toEqual(['b', "echo ''"])
  expect(bare('cat <<EOF\nbody')).toEqual(['cat'])
  expect(bare(')) ;;')).toEqual([])
  expect(bare('echo `a')).toEqual(['a', "echo ''"])
})
