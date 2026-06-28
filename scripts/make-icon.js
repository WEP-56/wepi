const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { Icns, IcnsImage } = require("@fiahfy/icns");

const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.resolve(rootDir, process.argv[2] ?? "images/icon.png");
const buildDir = path.resolve(rootDir, "build");
const iconsDir = path.resolve(buildDir, "icons");
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icnsTypes = [
	[16, "icp4"],
	[32, "icp5"],
	[64, "icp6"],
	[128, "ic07"],
	[256, "ic08"],
	[512, "ic09"],
	[1024, "ic10"],
];

async function renderPng(size) {
	return sharp(sourcePath)
		.resize(size, size, {
			fit: "contain",
			background: { r: 0, g: 0, b: 0, alpha: 0 },
			kernel: sharp.kernel.lanczos3,
		})
		.png()
		.toBuffer();
}

async function writePngSet() {
	await fs.mkdir(iconsDir, { recursive: true });
	await Promise.all(
		pngSizes.map(async (size) => {
			const buffer = await renderPng(size);
			await fs.writeFile(path.join(iconsDir, `${size}x${size}.png`), buffer);
			if (size === 512) await fs.writeFile(path.join(buildDir, "icon.png"), buffer);
		}),
	);
}

async function writeIco() {
	const pngToIco = (await import("png-to-ico")).default;
	const buffers = await Promise.all(icoSizes.map(renderPng));
	const ico = await pngToIco(buffers);
	await fs.writeFile(path.join(buildDir, "icon.ico"), ico);
}

async function writeIcns() {
	const icns = new Icns();
	for (const [size, osType] of icnsTypes) {
		const buffer = await renderPng(size);
		icns.append(IcnsImage.fromPNG(buffer, osType));
	}
	await fs.writeFile(path.join(buildDir, "icon.icns"), icns.data);
}

async function writeSvgWrapper() {
	const source = await fs.readFile(sourcePath);
	const base64 = source.toString("base64");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <image width="1024" height="1024" href="data:image/png;base64,${base64}"/>
</svg>
`;
	await fs.writeFile(path.join(buildDir, "icon.svg"), svg, "utf8");
}

async function main() {
	const metadata = await sharp(sourcePath).metadata();
	if (metadata.width !== metadata.height) {
		throw new Error(`Icon source must be square, got ${metadata.width}x${metadata.height}`);
	}
	await fs.mkdir(buildDir, { recursive: true });
	await Promise.all([writePngSet(), writeIco(), writeIcns(), writeSvgWrapper()]);
	console.log(`Generated app icons from ${path.relative(rootDir, sourcePath)}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
