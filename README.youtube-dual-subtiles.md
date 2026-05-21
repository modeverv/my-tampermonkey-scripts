# YouTube Dual Subtitles

Tampermonkey userscript for showing two YouTube caption streams at once:

- original caption track, default `en`
- YouTube auto-translated caption track, default `ja`

The script reads caption track URLs from the YouTube player response, fetches
the `timedtext` JSON3 data, and renders its own two-line overlay inside the
video player.

The small `Dual Sub ON/OFF` button in the upper-right corner of the video
player toggles the overlay. The last state is saved in `localStorage`, so if you
turn it off once it stays off until you turn it on again.

## Demo

![Demo](./materials/youtube-dual.png)

sample youtube video(thank you): https://www.youtube.com/watch?v=L9QZ97y9Exg 

## Install

1. Open Tampermonkey's dashboard.
2. Create a new script.
3. Paste `youtube-dual-subtitles.user.js`.
4. Save it, then open a YouTube video that has English captions.

The language defaults are at the top of the script:

```js
const CONFIG = {
  originalLang: "en",
  translatedLang: "ja",
};
```

## Notes

- Manual English captions are preferred over ASR captions when both exist.
- The translated line uses YouTube's own `tlang` auto-translation endpoint.
- Recent YouTube pages may require a proof token on `timedtext` requests. If the
  first caption fetch is empty, the script briefly toggles YouTube's native
  caption button, reads the tokenized request that the player emits, and retries.
- Some videos disable or omit captions, so there may be no data to show.
