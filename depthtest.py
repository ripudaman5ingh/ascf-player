import torch
from transformers import pipeline
from PIL import Image

print("MPS available:", torch.backends.mps.is_available())

dev = "mps" if torch.backends.mps.is_available() else "cpu"
pipe = pipeline("depth-estimation",
                model="depth-anything/Depth-Anything-V2-Small-hf",
                device=dev)

# make a tiny test image
Image.new("RGB", (256, 256), (120, 120, 120)).save("t.png")
out = pipe(Image.open("t.png"))
print("depth map size:", out["depth"].size)
print("OK — depth model runs on", dev)
