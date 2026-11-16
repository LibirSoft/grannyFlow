# granny tag

When the user says `granny tag`, or asks that a kind of small finding always be fixed (a misspelled word, a name that says something other than what the code does), follow this. It adds, removes or lists one config tag with one script command. It launches no run and changes no code.

A config tag names a kind of finding. The judge names the tag that fits a finding it reports, and the engine then adds the tag's points to the finding's priority, or fixes the finding outright. The rules are in [config.md](config.md#tags).

## The commands

Run the script from the skill directory with `node`. On success it prints its result and exits 0. On a refusal it prints the reason, exits 1 and writes nothing.

```sh
node <skill-dir>/scripts/tags.mjs add <name> --description <text> (--points <1-100> | --fix) [--project] [--replace] [--repo <dir>]
node <skill-dir>/scripts/tags.mjs remove <name> [--project] [--repo <dir>]
node <skill-dir>/scripts/tags.mjs list [--repo <dir>]
```

- Without `--project` the tag goes to the user config: `$GRANNY_CONFIG` when it is set, else `$XDG_CONFIG_HOME/granny/config.json`, else `~/.config/granny/config.json`. The opencode, omp, Claude Code and Cursor hosts all read that file, so the tag holds in every project.
- With `--project` the tag goes to `granny.config.json` at the top of the git checkout the command runs in, or of the one `--repo <dir>` names. Run it in the main checkout, or pass `--repo` with that checkout's path. A run reads the main checkout's `granny.config.json`, so inside a granny worktree the command writes the worktree's own file, and runs ignore the tag until that file reaches the main checkout. Outside a git checkout the command fails with `--project needs a git checkout: run it in the repo or pass --repo <dir>`. The command does not commit the file: tell the user that it is theirs to commit, and that only a committed file reaches the team.
- `add` refuses a name the file already has, and `--replace` changes it. The description is what the judge reads, so give one concrete line.
- `remove` says which file holds the tag when the file asked about does not.
- `list` shows the tags of both files merged: the name, the effect (`fix`, `+<points>`, or `off` when a project `null` turns a user tag off), the file it comes from and the description.

The script changes only `tags.<name>`. It writes the whole file again with 2-space indentation, so a file formatted by hand is re-indented; every other key keeps its place and value. A file that is not valid JSON, or whose top level is not an object, is left as it is.

## Choosing the effect

- `--fix` for a kind of finding that must be fixed whatever its priority, such as a misspelled word in a comment or a string.
- `--points <n>` to weigh a kind of finding against the threshold. A finding's priority is its impact and likelihood in [the decision table](config.md#the-decision-table), plus the fix cost (`trivial` +15, `small` 0, `large` -15), plus the points, clamped to 100. A `minor` finding's priority is 0 to 50, and 40 or 50 when its fix is trivial and it is not `rare`. With the default `threshold` of 70 a finding starts a fix round only when its priority is above 70. Points that take it to `rideAlong` (55) but not above 70 only make it go along with a round that has a fix; it never starts one.

A tag applies in the stage reviews and in the final review. It does not apply in the plan review, in `granny judge`, to a P0/P1 finding, or to a repeat of a finding the fixer declined.

## The cost

A tag that starts a fix round starts it the same way any finding does: one fix agent, the stage's checks, and one more full review round - every reviewer again, and the judge when they find something. Reviewers find new small things on each pass, so a stage can run to `maxRounds` and end `round-cap`. In the last round the fix still runs, but nothing reviews it, and its findings are listed as unresolved. `maxRounds` is the only limit. Say so to the user before they add a `fix` tag or a large number of points.

## The steps

1. Take the name, the description and the effect from the user. If the user gives no description, write one concrete line and show it before the command runs.
2. Run the `add`, `remove` or `list` command from the skill directory, with the `--project` and `--repo` the user asked for.
3. Relay the result line to the user, with the file it names. On a refusal, relay the reason; the file is unchanged.

The tags apply to the next run. A run that has started keeps the tags it read when it started.

## The example

```json
{
  "tags": {
    "typo": { "description": "a misspelled word in a comment, a string or a doc", "fix": true },
    "naming": { "description": "a name that says something other than what the code does", "points": 20 }
  }
}
```
