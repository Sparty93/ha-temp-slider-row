# Temperature Slider Row

A Lovelace entity **row** with a slider that only moves when you grab the thumb.

## Why

`slider-entity-row` renders a native `<ha-slider>` — an `<input type="range">`.
Tapping anywhere on a range input jumps the thumb to that point. That is browser
behaviour, not a setting, so no config option or CSS can disable it. On a phone
that means scrolling past a column of sliders changes them.

This row draws its own track and thumb and handles pointer events directly:

- a drag starts **only** if the pointer lands within 24px of the thumb
- touching the track does **nothing at all**
- vertical movement is never captured, so the page scrolls normally
- the value updates live while dragging, but **one** service call is sent on release

That last point also cuts Zigbee traffic dramatically versus a slider that fires
continuously while being dragged.

## Install

HACS → Frontend → ⋮ → Custom repositories → add this repo, category **Lovelace**.
Then install, and hard-refresh the browser (companion app: clear the frontend cache
and force-stop, a page refresh is not enough).

## Usage

```yaml
type: entities
entities:
  - type: custom:temp-slider-row
    entity: climate.office_radiator
```

## Options

| Option | Default | Description |
|---|---|---|
| `entity` | **required** | `climate.*`, `water_heater.*`, `input_number.*` or `number.*` |
| `min` | entity's `min_temp` / `min` | Lower bound |
| `max` | entity's `max_temp` / `max` | Upper bound |
| `step` | entity's `target_temp_step` / `step` | Increment |
| `show_value` | `true` | Show the value to the right of the track |
| `unit` | `"°"` | Suffix for the value label |
| `color` | auto | Fixed fill colour. Omit to follow the entity's mode. |
| `profile` | auto | `master`, `radiator`, `zone`, `thermostat` or `plain` — picks the colour rules |
| `heating_master` | – | Boolean that gates radiators (greys the fill when off) |
| `ac_master` | – | Climate entity that overrides radiators (greys the fill when not off) |
| `height` | `18` | Track thickness in px |

## Fill colour

The fill follows what the system is actually doing, matching the icon colours on
the same row so the two can never disagree:

| Profile | Rules |
|---|---|
| `master` | Drives both systems. AC on → the AC's colour; else heating master on → orange; else grey. |
| `radiator` | AC master on, heating master off, or room off → grey. `hvac_action: heating` → orange. Idle → neutral. |
| `zone` | cooling → blue, heating → deep orange, fan/drying → cyan, otherwise grey |
| `thermostat` | off → grey, cooling → blue, heating → deep orange, otherwise neutral |
| `plain` | theme primary, or whatever `color` you set |

Idle is deliberately neutral rather than the mode colour — an idle zone showing
as "cooling" is misleading.

## Supported domains

`climate` and `water_heater` set the target temperature; `input_number` and
`number` set the value.
