# 말컷

말 없는 구간을 자르고 배경 소리를 줄이는 웹 영상 도구입니다. 영상은 서버로 전송되지 않고 기기의 브라우저 안에서 처리됩니다. Android·PC의 최신 Chrome 사용을 권장합니다.

## GitHub Pages로 배포
1. 이 폴더의 파일을 저장소 맨 위에 올립니다.
2. 저장소의 Settings > Pages에서 Branch를 `main`, 폴더를 `/ (root)`로 지정합니다.

## 포함한 라이브러리
영상 읽기와 저장에 [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0)를 사용합니다.

## 소스 코드
`source/` 폴더에 원본 코드가 있습니다. `npm install` 후 `node build.js`로 빌드합니다.
