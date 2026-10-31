"""Generate original vector goggles icons. Requires reportlab; never used at plugin runtime."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

root = Path(__file__).resolve().parents[1] / "icons"
for theme, foreground in [("light", "#24292f"), ("dark", "#f0f6fc")]:
    out = canvas.Canvas(str(root / f"copilot-{theme}.pdf"), pagesize=(256, 256), invariant=1)
    out.scale(4, 4)
    out.setTitle("Local Copilot agent icon")
    out.setStrokeColor(HexColor(foreground))
    out.setLineWidth(4)
    out.setLineCap(1)
    out.roundRect(8, 17, 48, 31, 11, stroke=1, fill=0)
    out.line(4, 27, 4, 37)
    out.line(60, 27, 60, 37)
    out.line(32, 49, 32, 55)
    out.setFillColor(HexColor("#8250df" if theme == "light" else "#c8a5ff"))
    out.circle(32, 57, 3, stroke=0, fill=1)
    out.roundRect(15, 26, 14, 14, 5, stroke=0, fill=1)
    out.roundRect(35, 26, 14, 14, 5, stroke=0, fill=1)
    out.line(27, 22, 37, 22)
    out.showPage()
    out.save()
    print(root / f"copilot-{theme}.pdf")
