from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "og-preview.png"
WIDTH = 1200
HEIGHT = 630


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Helvetica.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default(size=size)


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, size: int, fill: str, bold: bool = False) -> None:
    draw.text(xy, value, font=font(size, bold), fill=fill)


def text_width(draw: ImageDraw.ImageDraw, value: str, size: int, bold: bool = False) -> int:
    box = draw.textbbox((0, 0), value, font=font(size, bold))
    return box[2] - box[0]


def fitted_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    value: str,
    size: int,
    max_width: int,
    fill: str,
    bold: bool = False,
    min_size: int = 16,
) -> None:
    while size > min_size and text_width(draw, value, size, bold) > max_width:
        size -= 1
    draw.text(xy, value, font=font(size, bold), fill=fill)


def pill(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, size: int, fill: str, text_fill: str) -> None:
    x, y = xy
    padding_x = 28
    padding_y = 12
    width = text_width(draw, value, size, True) + padding_x * 2
    height = size + padding_y * 2
    draw.rounded_rectangle((x, y, x + width, y + height), radius=height // 2, fill=fill)
    text(draw, (x + padding_x, y + padding_y - 2), value, size, text_fill, True)


def tolerance_row(draw: ImageDraw.ImageDraw, y: int, label: str, value_pct: float, value: str) -> None:
    left = 720
    right = 1080
    track_y = y + 52
    text(draw, (left, y), label, 28, "#eaf4ef", True)
    text(draw, (right - 92, y), value, 24, "#9ee6c1", True)
    draw.rounded_rectangle((left, track_y, right, track_y + 18), radius=9, fill="#274b46", outline="#58706c", width=2)
    marker_x = left + int((right - left) * value_pct)
    draw.ellipse((marker_x - 16, track_y - 7, marker_x + 16, track_y + 25), fill="#9ee6c1", outline="#ffffff", width=4)
    text(draw, (left, track_y + 30), "min", 20, "#91a39f", True)
    text(draw, (right - 38, track_y + 30), "max", 20, "#91a39f", True)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (WIDTH, HEIGHT), "#eef2f0")
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((44, 44, WIDTH - 44, HEIGHT - 44), radius=30, fill="#172226")
    pill(draw, (80, 82), "openpilot route utility", 21, "#d9f2e7", "#173d39")

    text(draw, (80, 166), "Invalid", 70, "#f7fbf9", True)
    text(draw, (80, 242), "calibration", 70, "#f7fbf9", True)
    text(draw, (80, 318), "scanner", 70, "#f7fbf9", True)
    text(draw, (82, 420), "Quick look for current tolerance.", 29, "#cfe0da", False)
    text(draw, (82, 462), "Full qlog scan for invalid calibration.", 29, "#cfe0da", False)

    draw.rounded_rectangle((80, 530, 600, 582), radius=26, fill="#244540")
    fitted_text(
        draw,
        (108, 543),
        "ophwug.github.io/op-calibration-reading-tool",
        21,
        464,
        "#9ee6c1",
        True,
        min_size=18,
    )

    draw.rounded_rectangle((682, 130, 1120, 500), radius=24, fill="#203034", outline="#3a5550", width=2)
    text(draw, (720, 176), "Tolerance landing", 33, "#f7fbf9", True)
    tolerance_row(draw, 250, "Pitch", 0.93, "9.44 deg")
    tolerance_row(draw, 372, "Yaw", 0.53, "0.26 deg")

    image.save(OUT, "PNG", optimize=True)


if __name__ == "__main__":
    main()
