import base64
import math

QR_SHAPES = ("circle", "square", "diamond", "dot", "star")


def _module_svg(shape: str, x: float, y: float, m: float, color: str) -> str:
    """SVG element for one dark module of size m at (x, y)."""
    cx, cy = x + m / 2, y + m / 2
    if shape == "circle":
        return f'<circle cx="{cx}" cy="{cy}" r="{m / 2}" fill="{color}"/>'
    if shape == "dot":
        return f'<circle cx="{cx}" cy="{cy}" r="{m * 0.33}" fill="{color}"/>'
    if shape == "diamond":
        pts = f"{cx},{y - m * 0.08} {x + m * 1.08},{cy} {cx},{y + m * 1.08} {x - m * 0.08},{cy}"
        return f'<polygon points="{pts}" fill="{color}"/>'
    if shape == "star":
        pts = " ".join(
            f"{cx + (m * 0.62 if i % 2 == 0 else m * 0.28) * math.sin(i * 3.14159265 / 4)},"
            f"{cy - (m * 0.62 if i % 2 == 0 else m * 0.28) * math.cos(i * 3.14159265 / 4)}"
            for i in range(8))
        return f'<polygon points="{pts}" fill="{color}"/>'
    return f'<rect x="{x}" y="{y}" width="{m}" height="{m}" fill="{color}"/>'


def generate_custom_qr_svg(data: str, color: str = "#000000", logo_path=None, size: int = 300,
                           bg: str = "#ffffff", shape: str = "circle") -> str:
    import qrcode
    if shape not in QR_SHAPES:
        shape = "circle"
    qr = qrcode.QRCode(version=None, error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=4)
    qr.add_data(data)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    n = len(matrix)

    module_size = size / n
    cutout_radius = size * 0.15

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">',
        f'<rect width="100%" height="100%" fill="{bg}"/>'
    ]

    for y, row in enumerate(matrix):
        for x, cell in enumerate(row):
            if cell:
                cx = x * module_size
                cy = y * module_size
                svg.append(_module_svg(shape, cx, cy, module_size, color))

    svg.append(
        f'<circle cx="{size/2}" cy="{size/2}" r="{cutout_radius}" fill="{bg}"/>'
    )

    if logo_path:
        with open(logo_path, "rb") as f:
            data_bytes = f.read()
            if logo_path.lower().endswith(".svg"):
                logo_data = data_bytes.decode("utf-8")
                svg.append(
                    f'<g transform="translate({size/2 - cutout_radius/2},{size/2 - cutout_radius/2})">'
                    f'{logo_data}</g>'
                )
            else:
                encoded = base64.b64encode(data_bytes).decode("utf-8")
                logo_size = cutout_radius * 1.5
                svg.append(
                    f'<image x="{size/2 - logo_size/2}" y="{size/2 - logo_size/2}" '
                    f'width="{logo_size}" height="{logo_size}" '
                    f'href="data:image/png;base64,{encoded}" />'
                )

    svg.append('</svg>')
    return "\n".join(svg)
