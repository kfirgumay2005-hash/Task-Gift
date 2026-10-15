/** File types accepted as gift backgrounds. GIFs are images: they animate as CSS backgrounds. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v"];
export const BACKGROUND_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

function extension(path: string): string {
	return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

export function isVideo(path: string): boolean {
	return VIDEO_EXTENSIONS.includes(extension(path));
}

export function isBackgroundFile(path: string): boolean {
	return BACKGROUND_EXTENSIONS.includes(extension(path));
}
