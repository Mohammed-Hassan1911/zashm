# Product photography brief — Textured Zip Jacket (Burgundy)

Status: **local only**. Nothing here has been uploaded to Supabase Storage or
deployed. The existing four production images stay untouched until the owner
approves a replacement.

## Current state (measured, not guessed)

| Item | Value |
|---|---|
| Product | `Textured Zip Jacket`, category `Jackets`, colour `Burgundy` only |
| Production images | 4 × JPEG, all `750×1000` (3:4), `92–121 KB` |
| Image 1 / 2 / 3 | dark warm-brown studio, bright hotspot top-left (`80–101` luminance) vs right edge `19–21` |
| Image 3 | sharpness `166` vs `554–750` for the others — reads as soft |
| Image 4 | red backdrop (`94,27,39`), mean luminance `15` vs `26–33` — looks like a different product |
| All four | dark side panels / empty-looking edges; `750×1000` is too soft for the 300% zoom |

## Target

1. **Master `1500×2000` (3:4)** for the lightbox zoom; derive `750×1000` for cards.
2. **Better, consistent background**: seamless warm-neutral charcoal, even light,
   no corner hotspot, no colour cast, no props, no floor line.
3. **Full-bleed framing**: the garment fills the frame edge to edge with only a
   thin even halo of background. No empty side panels, no large top gap. Because
   of this, the temporary CSS headroom mat can be removed as a separate,
   approved follow-up once the new images are live.
4. **Six shots** covering the questions buyers actually ask (front, back,
   zipper, fabric, fit, interior).
5. **Descriptive, distinct alt text** per image for accessibility and SEO.

## Background / lighting spec (shared by every shot)

- Backdrop: seamless warm-neutral charcoal, `#211E1C → #2B2724` soft radial
  gradient, matte, extending to all four edges.
- Light: soft diffused key at 45° camera-left, gentle fill right, subtle rim to
  separate the fabric. Neutral 5600K. No hotspot, no vignette, no colour cast —
  the burgundy must not pick up a red reflection from the backdrop.
- Fabric: deep wine burgundy, true to the swatch, textured weave clearly visible.
- Camera: straight-on 85mm equivalent, centred, no perspective distortion.
- Composition: garment ≈ 90% of frame width, thin even background halo, no
  empty left/right bands, no large empty top band.
- Export: master JPEG q85 `1500×2000`; card derivative `750×1000` JPEG q85 plus
  WebP q80 / AVIF q60. Keep card files under ~180 KB.

## Shot list, filenames and alt text

| # | File | Shot | Alt text |
|---|---|---|---|
| 01 | `01-front.jpg` | Front, fully zipped, laid flat | "Burgundy textured zip jacket, front view with zipper fastened" |
| 02 | `02-back.jpg` | Back, laid flat | "Back view of the burgundy textured zip jacket showing yoke and shoulders" |
| 03 | `03-zipper-detail.jpg` | Macro of zipper, placket and collar | "Close-up of the zipper teeth, stitched placket and collar on the burgundy jacket" |
| 04 | `04-fabric-macro.jpg` | Macro of the woven texture | "Macro detail of the burgundy textured fabric weave" |
| 05 | `05-on-model.jpg` | On-model fit, shoulders to upper thigh | "Model wearing the burgundy textured zip jacket, front fit view" |
| 06 | `06-interior.jpg` | Lining, inner pocket, zipper reverse | "Interior lining and pocket detail of the burgundy zip jacket" |

## Generation prompts (English, copy-ready)

Shared base — prepend to every shot below:

> Luxury e-commerce product photography for a premium fashion store.
> Photorealistic studio shot of a deep wine-burgundy textured zip-up jacket.
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

Shot additions:

1. "Front view: jacket laid flat and fully zipped, collar open and symmetrical,
   sleeves relaxed along the body, hem straight, zipper pull and textured weave
   clearly legible."
2. "Back view: same jacket laid flat, showing back yoke, shoulder seams and
   straight hem, fully zipped, identical backdrop and light."
3. "Macro detail: extreme close-up of the centre-front zipper teeth, zipper
   tape, placket stitching and stand collar, fabric tack sharp, soft background
   falloff only."
4. "Fabric macro: extreme close-up of the burgundy textured fabric weave filling
   the entire frame, rich wine-red tone, individual threads visible, soft raking
   light revealing the texture."
5. "On-model fit: elegant model wearing the jacket zipped, cropped from shoulders
   to upper thigh, arms relaxed at sides, head out of frame, focus entirely on
   garment fit and drape, same neutral backdrop."
6. "Interior detail: jacket opened flat showing the inner lining, internal pocket
   and reverse of the zipper, clean and pressed, same backdrop and light."

Negative prompt for all shots:

> illustration, painting, CGI, cartoon, distorted zipper, extra sleeves,
> duplicated collar, unrealistic fabric, bright red background, harsh corner
> hotspot, heavy vignette, empty side margins, floating text, logo, watermark,
> people in background, blurry fabric, oversaturated colour

## Hand-off / rollout (requires explicit approval before any of it)

1. Review the locally generated images below; pick or refine.
2. Export masters `1500×2000` and card derivatives `750×1000` + WebP/AVIF.
3. Upload to a **staging** path in Supabase Storage first; verify zoom sharpness
   and card framing at 320/375/768/1440px.
4. Only then replace the four live object paths — this is a production data
   change and needs owner approval. Keep the originals as backup.
5. Add `srcset` for the 2x master in the lightbox, distinct `alt` text per image,
   and remove the CSS headroom mat in the same approved change.
