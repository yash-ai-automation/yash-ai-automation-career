#!/usr/bin/env node

/**
 * generate-pdf-latex.mjs — LaTeX → PDF via Tectonic
 *
 * Usage:
 *   node generate-pdf-latex.mjs <input.tex> <output.pdf>
 *
 * Requires: tectonic installed and available in PATH.
 * Uses Tectonic to compile LaTeX and produce an ATS-parseable PDF.
 * Tectonic auto-downloads required LaTeX packages on first run.
 */

import { resolve, dirname, basename } from 'path';
import { readFile, writeFile, copyFile, mkdir, stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function generatePDF() {
  const args = process.argv.slice(2);

  let inputPath, outputPath;

  for (const arg of args) {
    if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-pdf-latex.mjs <input.tex> <output.pdf>');
    process.exit(1);
  }

  inputPath = resolve(inputPath);
  outputPath = resolve(outputPath);

  console.log(`📄 Input:  ${inputPath}`);
  console.log(`📁 Output: ${outputPath}`);

  // Verify input file exists
  try {
    await stat(inputPath);
  } catch {
    console.error(`❌ Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  await mkdir(outputDir, { recursive: true });

  // Compile with tectonic
  // Tectonic compiles .tex and outputs .pdf in the same directory as input by default.
  // We compile in a temp-like location then move the result.
  const inputDir = dirname(inputPath);
  const inputBasename = basename(inputPath, '.tex');

  console.log(`🔧 Compiling with Tectonic...`);

  let tectonicOutput = '';
  try {
    const { stdout, stderr } = await execFileAsync('tectonic', [
      '-X', 'compile',
      inputPath,
      '--outdir', outputDir,
      '--keep-logs',
    ], {
      cwd: inputDir,
      timeout: 120000, // 2 minutes max
    });

    tectonicOutput = (stdout || '') + (stderr || '');
    if (stdout) console.log(stdout);
    if (stderr) console.log(stderr);
  } catch (err) {
    console.error(`❌ Tectonic compilation failed:`);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    console.error(err.message);
    process.exit(1);
  }

  // Tectonic outputs the PDF with the same basename as the input .tex
  const compiledPdfPath = resolve(outputDir, `${inputBasename}.pdf`);

  // If the compiled PDF path differs from the desired output path, rename it
  if (compiledPdfPath !== outputPath) {
    try {
      await copyFile(compiledPdfPath, outputPath);
      const { unlink } = await import('fs/promises');
      await unlink(compiledPdfPath);
    } catch (err) {
      // If copy fails, the file might already be at the right path
      console.log(`⚠️  Could not rename ${compiledPdfPath} → ${outputPath}: ${err.message}`);
    }
  }

  // Read the output PDF to get size and page count
  try {
    const pdfBuffer = await readFile(outputPath);
    // XeTeX PDFs use compressed object streams, so simple regex on raw PDF won't find /Type /Page.
    // Instead, parse the tectonic log for the page count (e.g., "Output written on ... (N pages, ...)")
    let pageCount = 0;
    try {
      const logPath = resolve(outputDir, `${inputBasename}.log`);
      const logContent = await readFile(logPath, 'utf-8');
      const pageMatch = logContent.match(/Output written on .+?\((\d+) pages?/);
      if (pageMatch) pageCount = parseInt(pageMatch[1], 10);
    } catch {
      // Fall back to raw PDF regex (works for uncompressed PDFs)
      const pdfString = pdfBuffer.toString('latin1');
      pageCount = (pdfString.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
    }

    console.log(`✅ PDF generated: ${outputPath}`);
    console.log(`📊 Pages: ${pageCount}`);
    console.log(`📦 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    return { outputPath, pageCount, size: pdfBuffer.length };
  } catch (err) {
    console.error(`❌ PDF output not found at: ${outputPath}`);
    console.error(`   Check Tectonic output for compilation errors.`);
    process.exit(1);
  }
}

generatePDF().catch((err) => {
  console.error('❌ PDF generation failed:', err.message);
  process.exit(1);
});
