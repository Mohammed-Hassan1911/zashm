# Reusable product-image prompt templates

Two reusable prompt sets: **TOPWEAR** (jackets, shirts, knitwear — worn above the
waist) and **BOTTOMWEAR** (trousers, jeans, skirts — worn below the waist).

How to use: replace `{PRODUCT}`, `{COLOUR}` and `{FABRIC}`, then append **one**
angle line from the relevant set to the shared base. Every angle line already
includes its own subject description. Add the shared negative prompt as well.

These are text prompts only. Nothing was generated (image credits ran out) and
nothing was uploaded or deployed.

---

## SHARED BASE (prepend to every angle)

> Luxury e-commerce product photography for a premium fashion store.
> Photorealistic studio shot of a {PRODUCT} in {COLOUR} with {FABRIC}.
> Seamless warm-neutral charcoal backdrop (#211E1C to #2B2724 soft radial
> gradient) reaching every edge of the frame — no props, no floor line, no
> horizon, no text, no logo, no watermark. Full-bleed composition: the garment
> fills the frame from edge to edge, about 90% of the frame width, with only a
> thin even halo of background; absolutely no large empty margins on the left or
> right and no large empty band at the top. Soft diffused key light from
> camera-left at 45 degrees, gentle fill from the right, neutral 5600K white
> balance with no colour cast, subtle rim light separating the fabric from the
> background, no harsh hotspot in any corner. Centred, straight-on 85mm
> perspective, no lens distortion, crisp fabric texture, catalogue-grade detail.
> Vertical 3:4 portrait, 1500x2000.

## SHARED NEGATIVE (append to every angle)

> illustration, painting, CGI, cartoon, deformed garment, extra sleeves, extra
> legs, duplicated collar, duplicated waistband, unrealistic fabric, bright red
> background, harsh corner hotspot, heavy vignette, empty side margins, floating
> text, logo, watermark, people in background, blurry fabric, oversaturated
> colour

---

## TOPWEAR — jackets, shirts, knitwear

1. **Front, laid flat:** Fully fastened, collar open and symmetrical, sleeves
   relaxed along the body, hem straight, closure and fabric weave clearly
   legible.
2. **Back, laid flat:** Same garment from the back, showing yoke, shoulder seams
   and straight hem, identical backdrop and light.
3. **Left side:** Three-quarter view from the model's left, showing sleeve
   volume, side seam and drape.
4. **Right side:** Three-quarter view from the model's right, same distance and
   light, showing the opposite side seam and closure edge.
5. **Closure and collar macro:** Extreme close-up of the zipper teeth or
   buttons, zipper tape / buttonhole stitching, placket and stand collar, fabric
   tack sharp, soft background falloff only.
6. **Fabric macro:** Extreme close-up of the {FABRIC} filling the entire frame,
   true {COLOUR} tone, individual threads visible, soft raking light revealing
   the texture.
7. **On-model fit:** Elegant model wearing the garment fastened, cropped from
   shoulders to upper thigh, arms relaxed at sides, head out of frame, focus
   entirely on fit and drape, same neutral backdrop.
8. **Interior detail:** Garment opened flat showing the inner lining, internal
   pocket and reverse of the closure, clean and pressed, same backdrop and
   light.

## BOTTOMWEAR — trousers, jeans, skirts

1. **Front, laid flat:** Waistband to hem, fully fastened, front crease and
   pockets clean, fly and belt loops clearly legible.
2. **Back, laid flat:** Same garment from the back, showing yoke, back pockets
   and straight hem, identical backdrop and light.
3. **Left side:** True side profile from the model's left, showing rise, hip
   line, leg silhouette and side seam.
4. **Right side:** True side profile from the model's right, same distance and
   light, showing the opposite seam and pocket edge.
5. **Waistband and closure macro:** Extreme close-up of the waistband stitches,
   button or zipper fly, belt loops and fly stitching, fabric tack sharp, soft
   background falloff only.
6. **Fabric and seam macro:** Extreme close-up of the {FABRIC}, a folded seam and
   topstitching filling the frame, true {COLOUR} tone, individual threads
   visible, soft raking light revealing the texture.
7. **On-model fit:** Elegant model wearing the garment, cropped from waist to
   ankle (or knee for skirts), head out of frame, hands relaxed, focus entirely
   on fit, rise and drape, same neutral backdrop.
8. **Interior detail:** Garment opened flat showing the waistband facing,
   pocket bags, inner seam allowances and hem finish, clean and pressed, same
   backdrop and light.

---

## Example — this product

BASE + TOPWEAR angle 1 with `{PRODUCT} = textured zip jacket`,
`{COLOUR} = deep wine burgundy`, `{FABRIC} = textured woven fabric` reproduces
the `01-front` prompt in `docs/product-photography-brief.md`.
