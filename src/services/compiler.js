import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';

const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 30000);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 10000);
const OUTPUT_LIMIT = Number(process.env.OUTPUT_LIMIT || 64_000);
const SAFE_FLAG_PATTERN = /^[\w=+\-./: ]*$/;

export async function compileAndRun({ code, stdin, flags, onEvent }) {
  const workdir = path.join(os.tmpdir(), `cpp-online-${nanoid(10)}`);
  await mkdir(workdir, { recursive: true });

  const sourcePath = path.join(workdir, 'main.cpp');
  const outputPath = path.join(workdir, process.platform === 'win32' ? 'main.exe' : 'main');

  try {
    emit(onEvent, 'prepare', `Workspace: ${workdir}`);
    await writeFile(sourcePath, code, 'utf8');

    const flagArgs = parseFlags(flags);
    emit(onEvent, 'compile-start', 'Compiling with g++...');
    const compile = await runProcess('g++', [
      sourcePath,
      '-std=c++17',
      '-O0',
      '-pipe',
      '-Wall',
      ...flagArgs,
      '-o',
      outputPath
    ], { cwd: workdir, timeout: COMPILE_TIMEOUT_MS, phase: 'compile', onEvent });

    if (compile.exitCode !== 0) {
      emit(onEvent, 'compile-error', `Compile failed with exit code ${compile.exitCode}.`);
      return {
        ok: false,
        phase: 'compile',
        stdout: trimOutput(compile.stdout),
        stderr: trimOutput(compile.stderr),
        exitCode: compile.exitCode,
        durationMs: compile.durationMs
      };
    }

    emit(onEvent, 'compile-done', 'Compile finished.');
    emit(onEvent, 'run-start', 'Running executable...');
    const run = await runProcess(outputPath, [], {
      cwd: workdir,
      input: String(stdin ?? ''),
      timeout: RUN_TIMEOUT_MS,
      phase: 'run',
      onEvent
    });

    emit(onEvent, 'run-done', `Program exited with code ${run.exitCode}.`);
    return {
      ok: run.exitCode === 0,
      phase: 'run',
      stdout: trimOutput(run.stdout),
      stderr: trimOutput(run.stderr),
      exitCode: run.exitCode,
      durationMs: compile.durationMs + run.durationMs
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

function parseFlags(flags) {
  if (!flags) return [];
  if (typeof flags !== 'string' || !SAFE_FLAG_PATTERN.test(flags)) return [];
  return flags.split(' ').map((item) => item.trim()).filter(Boolean).slice(0, 16);
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      emit(options.onEvent, `${options.phase ?? 'process'}-stdout`, text);
      if (stdout.length > OUTPUT_LIMIT) child.kill('SIGKILL');
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      emit(options.onEvent, `${options.phase ?? 'process'}-stderr`, text);
      if (stderr.length > OUTPUT_LIMIT) child.kill('SIGKILL');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${error.message}`,
        durationMs: Date.now() - started
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : exitCode ?? 0,
        stdout,
        stderr: timedOut ? `${stderr}\nProcess timed out.` : stderr,
        durationMs: Date.now() - started
      });
    });

    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
  });
}

function emit(onEvent, event, message) {
  if (typeof onEvent === 'function') onEvent({ event, message, at: new Date().toISOString() });
}

function trimOutput(value) {
  if (value.length <= OUTPUT_LIMIT) return value;
  return `${value.slice(0, OUTPUT_LIMIT)}\n... output truncated ...`;
}
