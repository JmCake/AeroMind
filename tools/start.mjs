import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
const virtual=fileURLToPath(new URL(process.platform==="win32"?"../.venv/Scripts/python.exe":"../.venv/bin/python",import.meta.url));
const child=spawn(existsSync(virtual)?virtual:"python",["-m","aeromind.app","--open",...process.argv.slice(2)],{cwd:root,stdio:"inherit"});
child.on("error",e=>{console.error(e.message);process.exitCode=1;});
child.on("exit",code=>{process.exitCode=code??1;});
