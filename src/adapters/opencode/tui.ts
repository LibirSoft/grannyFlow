// opencode's TUI plugin entry (tui.js). The only file that imports @opentui/solid and solid-js:
// opencode maps both to its own copies when it loads a plugin's TUI module.
import * as ui from '@opentui/solid'
import * as solid from 'solid-js'
import { createTuiPlugin } from './tui-plugin'

export default createTuiPlugin({ ui, solid })
