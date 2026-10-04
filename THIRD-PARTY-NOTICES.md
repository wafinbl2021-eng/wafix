# Third-Party Notices

Daltoon X ships third-party and separately-licensed software. This file records
what Daltoon X depends on, what it merely launches, and the licence terms that
come with each.

## Runtime dependencies

The licences for the crates and npm packages Daltoon X links against are those
of the respective upstream projects, and are reproduced in their own
repositories. They are not restated here. Daltoon X's own licence is in
[LICENSE](LICENSE).

## Steam LuaTools

Daltoon X can start **LuaTools**, a separate program for working with Steam
depots. This is a launcher integration only, and the distinction matters:

- Daltoon X **does not** ship, bundle, copy, extract or download `LuaTools.exe`,
  its installer, or any other LuaTools file.
- Daltoon X **does not** contain LuaTools source code.
- Daltoon X **does not** install, update or uninstall LuaTools. LuaTools has its
  own installer and its own auto-updater, both operated by its own authors.
- Daltoon X only looks for an already-installed `LuaTools.exe` in the standard
  per-user and per-machine install locations, and starts it with no arguments.

Because no LuaTools file is distributed with Daltoon X, the licence below
applies to the copy a user obtains from the LuaTools project itself, obtained
from its official site or its release page. Daltoon X asks the user to go there
rather than fetching anything on their behalf.

- Project: LuaTools
- Official site: <https://lua.tools/app>
- Releases: <https://github.com/madoiscool/LuaTools/releases/latest>
- Licence: MIT

LuaTools itself credits the following projects. That list is LuaTools' own, is
reproduced here for accuracy, and none of these are bundled by Daltoon X either:

- LuaTools
- Millennium
- Velopack
- DepotDownloaderMod
- SteamAutoCrack
- Steamless
- CloudRedirect

### MIT License

Copyright (c) 2026 LuaTools

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
