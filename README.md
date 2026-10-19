# IDS Token Store

A repository a Figma tokenexportokból CSS-t generál, az `ids-styles` tokenhivatkozásait ellenőrzi, és külön felhasználói művelettel frontend repositoryba publikál. A GitHub Actions és a GitLab CI/CD ugyanazokat az npm parancsokat használja.

| Művelet | Mit csinál? | Publikál célrepositoryba? |
|---------|-------------|-------------------------|
| CSS-generálás | Figma JSON → `ids_css/` | Nem |
| Tokenvalidáció | Generált komponens-tokenek összehasonlítása a kiválasztott `ids-styles` verzióval | Nem |
| CSS-publikálás | Az adott futtatás CSS-ét commitolja és pusholja a célrepositoryba | Igen, csak manuálisan |

## Bemenet és helyi használat

```text
foundations/
├── base/base.json
├── smc-colors/{dark,light}.json
├── smc-layout/{small,medium,large,xlarge}.json
└── smc-reference/smc-reference.json
components/
└── <komponens>/{comp-color,comp-size}/*.json
```

```bash
npm ci
npm run parse
# Kizárólag tokenvalidáció; előbb generálj CSS-t:
IDS_STYLES_REF=main npm run validate:ids-styles
# Publikálás a lent ismertetett cél- és hitelesítési beállításokkal:
npm run publish
```

A parser bemeneti gyökerét a `FIGMA_INPUT_DIR`, kimenetét a `CSS_OUTPUT_DIR` írhatja felül (alapérték: `ids_css`). Üres tokenbemenetnél a parser továbbra is sikeresen leáll. Helyileg az `npm run publish` előbb parse-ol; a CI a saját futtatásának CSS-artifactját használja `SKIP_PARSE=true` mellett. Ha ez az artifact hiányzik, a publish hibával leáll.

## Publikálási cél és biztonságos hitelesítés

A cél kiválasztása mindkét platformon azonos:

1. Ha a manuális `PUBLISH_TARGET_REPO_URL` paraméter üres, a meglévő `TARGET_REPO_URL` használatos. GitHubon a felületi mező neve `target_repo_url`.
2. Tetszőleges, technikailag érvényes HTTPS Git clone URL megadható, előzetes repository-regisztráció nélkül. A felülírás csak az aktuális publish-futtatásra vonatkozik; a konfigurált default URL-t nem módosítja.
3. Az URL nem tartalmazhat felhasználónevet, jelszót, tokent, queryt vagy fragmentet. Példa: `https://github.com/example/frontend.git`.
   A szolgáltató által megadott clone útvonalat használd; a script nem fűz hozzá automatikusan `.git` végződést.
4. A hitelesítésnek a kiválasztott repositoryhoz olvasási és írási jogosultság kell. Ezt a cél Git-szerver ellenőrzi; megfelelő jogosultság nélkül a clone vagy a push hibával leáll.

### Hitelesítés szerverváltáskor

A meglévő `TARGET_REPO_USERNAME` és `TARGET_REPO_TOKEN` secretek a `TARGET_REPO_URL` HTTPS-szerveréhez tartoznak. Ugyanazon szerveren más repositoryhoz is használhatók, ha a token ott is rendelkezik a szükséges jogokkal. Más protokollra, hostra vagy portra a script nem továbbítja őket.

Ha másik szerverhez tartozó hitelesítésre van szükség, a **`TARGET_REPO_CREDENTIALS` CI-secretben** add meg együtt a token kibocsátó szerverét és a hitelesítési adatokat. Egyetlen JSON objektumot használj, repositorylista nélkül:

```json
{"origin":"https://github.com","username":"publisher","token":"REPLACE_IN_CI_SECRET"}
```

Ez csak formátumpélda: a valódi tokent kizárólag a CI secretkezelőjében tárold, ne fájlban vagy manuális workflow-/job-inputban. Az `origin` a tokenhez tartozó HTTPS-szerver protokollja, hostja és opcionális portja; repositoryútvonalat nem tartalmazhat. A szerver adata és a token egy secretet alkot, így a manuális cél-URL nem kötheti át a meglévő tokent másik szerverhez.

Ha a kiválasztott cél originje egyezik a JSON-secret originjével, ezt a hitelesítést használja. Egyébként kizárólag a default szerveren használható a meglévő default hitelesítés. Így egy másik szerverhez beállított secret mellett az üres célmező továbbra is a default célhoz tartozó hitelesítést használhatja. Hibás secret vagy a kiválasztott szerverhez hiányzó hitelesítés esetén egyértelmű hiba keletkezik; sikertelen Git-művelet után nincs más tokennel történő próbálkozás. Ha nincs konfigurált `TARGET_REPO_URL`, a manuálisan megadott HTTPS-célhoz a JSON-secret szükséges, mert a külön username/token pár szervere nem állapítható meg biztonságosan.

Ez a beállítás a hitelesítés szerverhez kötését szolgálja: sem célrepositorykat, sem engedélyezett célok listáját nem kell konfigurálni. Bármely repository használható az adott szerveren, amennyiben a token jogosult rá.

A script csak a kiválasztott HTTPS hosthoz és repositoryútvonalhoz adja át a hitelesítést a Git credential protokollján. Nem ír tokent a clone URL-be, Git-konfigurációba vagy parancssori argumentumba. Letiltja a HTTP-átirányításokat, az örökölt Git credential helpereket, HTTP fejléceket, URL-átírásokat és Git trace kimenetet. A TLS-ellenőrzés aktív; belső CA esetén `GIT_SSL_CAINFO` használható. A célrepository nyers hibakimenete nem kerül a CI-logba; helyette a clone-, commit- vagy push-hiba okának ellenőrzéséhez ad útmutatást.

**Meglévő konfiguráció kompatibilitása:** ha a régi `TARGET_REPO_URL` secret már tartalmaz HTTPS felhasználónevet és tokent, a script ezeket memóriában leválasztja az URL-ről, és csak az eredeti default repositoryhoz használja. Így az üres célmezővel működő konfiguráció tovább használható. Új beállításnál külön `TARGET_REPO_USERNAME` és `TARGET_REPO_TOKEN` szükséges; a régi URL-secretről is erre érdemes átállni. A régi URL-be ágyazott hitelesítést eltérő repositoryhoz soha nem használja. Egy meglévő SSH default (`git@host:group/repo.git` vagy `ssh://git@host/group/repo.git`) előre konfigurált deploy key/SSH agent és ellenőrzött `known_hosts` mellett továbbra is használható; SSH-hoz ne állíts be HTTPS tokent. Manuális új célhoz HTTPS URL-t kell megadni.

A hitelesítési beállításokat csak megbízható maintainerek kezeljék. A publish secretekhez csak ellenőrzött brancheken futó kód kapjon hozzáférést. A GitLab manuális változói felülírhatják a projektváltozókat, ezért az azokat megadó felhasználókra ugyanaz a bizalmi követelmény vonatkozik, mint a publish konfigurációját kezelőkre. Ne adj általános, minden repositoryhoz hozzáférő személyes tokent a pipeline-nak.

### Megmaradó publish-beállítások

| Változó | Alapérték / jelentés |
|---------|---------------------|
| `TARGET_REPO_URL` | Meglévő default célrepository |
| `PUBLISH_TARGET_REPO_URL` | Opcionális manuális cél; üresen a default |
| `TARGET_REPO_USERNAME`, `TARGET_REPO_TOKEN` | Default HTTPS-szerverhez tartozó hitelesítés; együtt szükségesek |
| `TARGET_REPO_CREDENTIALS` | Opcionális JSON-secret: `origin`, `username`, `token`; például másik HTTPS-szerverhez |
| `TARGET_REPO_BRANCH` | `IDS_CSS`; a script szükség esetén létrehozza a branchet |
| `TARGET_CSS_PATH` | `projects/demo/src/assets/ids_css` |
| `TARGET_CHECKOUT_DIR` | `target-repo`; biztonságos relatív helyi könyvtár |
| `TARGET_COMMIT_MESSAGE` | `chore(tokens): update generated CSS` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | GitLab/helyi fallback: `token-pipeline`, `token-pipeline@example.invalid`; GitHubon a workflow botazonosítót ad |

A script csak a cél CSS-könyvtár tartalmát cseréli le. A célrepository többi fájlja megmarad; azonos CSS esetén nincs új commit vagy push. A célbranch védelmi szabályait továbbra is be kell tartani.

## GitHub Actions használata

Az **Actions → Token Pipeline → Run workflow** felületen az `operation` mező választja ki a műveletet:

| `operation` | Lefutó jobok |
|-------------|-------------|
| `generate` (default) | **Generate CSS** |
| `validate` | **Generate CSS** → **Validate tokens against ids-styles** |
| `publish` | **Generate CSS** → **Publish CSS** |
| Repository push | Csak **Generate CSS**, az eddigi útvonalszűrés szerint |

A push esemény akkor sem indíthat publish-t, ha a `publish-tokens` Environmentben nincsenek Required reviewers. A publish feltétele egyszerre a `workflow_dispatch` esemény és az explicit `publish` művelet. A validáció és a publish között nincs függőség; egyik nem indítja el a másikat. A kiválasztott művelet ugyanazon futtatás `ids_css` artifactját kapja meg.

### CSS-generálás

1. Pushold a tokenek vagy feldolgozó scriptek módosítását; a workflow automatikusan indul az érintett útvonalakon.
2. Kézi futtatáshoz válaszd a **Run workflow** gombot, a token-store forrásbranchét/tagjét, majd az `operation: generate` értéket.
3. A **Generate CSS** job logjában látszik a feldolgozás eredménye. A generált CSS az adott futtatás **Artifacts → ids_css** csomagjából tölthető le, hét napig.

A generált CSS forrásbranchre történő visszacommitolásának meglévő logikája megmarad; ez különbözik a célrepositoryba történő publikálástól. A GitHub `github.ref_protected` jelzése alapján védett branchre (a ruleseteket is beleértve), illetve tagre nem történik visszacommitolás; ehhez külön branchvédelmi API-jogosultság nem szükséges.

### Külön tokenvalidáció

1. **Run workflow**, majd válaszd a token-store ellenőrizendő forrásbranchét/tagjét és az `operation: validate` értéket.
2. Az `ids_styles_ref` mezőbe az **ids-styles** branchét, tagjét vagy commit SHA-ját írd, például `main` vagy `0.0.74`. Ez kizárólag a token-összehasonlítást befolyásolja; sem a publish célját, sem a publikálást nem módosítja.
3. Üres mezőnél a repository `IDS_STYLES_REF` változója használatos. Ha az sem létezik, a validáció hibával és hibariporttal áll le.
4. Indítsd el a futtatást. Ha a `validate-ids-styles` Environmenthez jóváhagyás tartozik, a **Review deployments** felületen hagyd jóvá.
5. A **Validate tokens against ids-styles** job logjában találod az eltéréseket. Az **Artifacts → token-diff-report** csomagban van a `token-diff-report.json`, sikeres és sikertelen összehasonlítás után is, hét napig. CSS-generálási vagy artifact-letöltési hiba esetén a validátor nem jut el az összehasonlításig.

### Manuális CSS-publish

1. **Run workflow**, válaszd a forrásbranchét/tagjét, majd az `operation: publish` értéket.
2. A `target_repo_url` mező opcionális. Üresen a konfigurált `TARGET_REPO_URL` célt használja. Eltérő célhoz adj meg tetszőleges érvényes HTTPS Git clone URL-t, hitelesítési adatok nélkül. Másik szerverhez annak saját, szerverhez kötött hitelesítése szükséges a fenti leírás szerint.
3. Indítsd el a futtatást. A CSS-generálás után, ha van Environment-jóváhagyási szabály, a **Review deployments** felületen hagyd jóvá a `publish-tokens` telepítést.
4. A **Publish CSS** job a futtatás saját CSS-artifactját publikálja a `TARGET_REPO_BRANCH` branch `TARGET_CSS_PATH` könyvtárába. `ids_styles_ref` megadása ehhez nem szükséges.
5. A job logjában látszik a siker, a változatlan CSS vagy az egyértelmű hiba. Sikertelen publish hibás jobot és hibás workflow-futtatást eredményez.

### Szükséges GitHub-beállítások

A **Settings → Secrets and variables → Actions** felületen:

- **Secrets:** `TARGET_REPO_USERNAME`, `TARGET_REPO_TOKEN`, illetve másik szerverhez szükség esetén `TARGET_REPO_CREDENTIALS` (a fenti JSON-formátumban). Célszerű a `publish-tokens` Environmenthez kötni őket, és csak ellenőrzött brancheket engedni erre az Environmentre.
- **Default cél:** a meglévő `TARGET_REPO_URL` secret működik tovább. Hitelesítési adatot nem tartalmazó URL azonos nevű Variable-ként is megadható; ha mindkettő létezik, a Secret az elsődleges.
- **Variables:** `IDS_STYLES_REF`, valamint a fenti táblázat opcionális branch-, könyvtár- és szerzőbeállításai.
- **Environments:** `publish-tokens` és `validate-ids-styles`. A Required reviewers további jóváhagyást adhatnak; a manuális publish működése nem függ ettől.
- A saját forrásrepositoryba történő CSS-visszacommitoláshoz a `parse_tokens` job `GITHUB_TOKEN`-je `contents: write` jogot kér. Ez a token nem szolgál automatikusan egy másik repository hitelesítésére.

GitHub célhoz használj a kiválasztott repositorykra korlátozott fine-grained PAT-ot **Contents: Read and write** jogosultsággal, vagy megfelelően jogosított GitHub App tokent. A szervezeti jóváhagyási és SSO-szabályoknak is teljesülniük kell. Más szolgáltató célrepositoryjához annak saját, korlátozott tokenje szükséges.

A **Run workflow** felület csak a default branchre felkerült workflow-hoz érhető el. A módosítások helyi elkészítése önmagában nem frissíti ezt a felületet.

## GitLab CI/CD használata

| Job | Indítás | CSS forrása |
|-----|---------|-------------|
| `parse_tokens` | Automatikus push-pipeline vagy **New pipeline** | A pipeline token-store checkoutjából generál |
| `validate_ids_styles_tokens` | Csak webes pipeline-ban, külön manuális job | Saját checkoutjából generál, majd összehasonlít |
| `publish_tokens` | Mindig külön manuális job | A saját pipeline `parse_tokens` artifactja |

### CSS-generálás

1. A tokeneket vagy feldolgozó scripteket érintő push az eddigi `workflow.rules.changes` alapján indít pipeline-t.
2. Manuálisan: **Build → Pipelines → New pipeline**, válaszd a token-store forrásbranchét/tagjét, majd **New pipeline**.
3. A `parse_tokens` automatikusan lefut. Logját a job oldalán, a CSS-t az ottani **Job artifacts / Browse / Download** felületen találod, hét napig.
4. A meglévő `commit-generated-css.sh` a nem védett, időközben el nem mozdult forrásbranchre továbbra is visszacommitolhatja a CSS-t. Ez nem célrepository-publish.

### Külön tokenvalidáció

1. Hozz létre egy webes pipeline-t a **New pipeline** felületen.
2. Az `IDS_STYLES_REF` pipeline-változóban add meg az ellenőrizni kívánt **ids-styles** branchét, tagjét vagy SHA-ját. Ha nem írod felül, a projektben beállított `IDS_STYLES_REF` marad érvényes.
3. A pipeline-ban nyisd meg a `validate_ids_styles_tokens` jobot. Az `IDS_STYLES_REF` itt is megadható jobváltozóként, majd **Run job**. Gyorsindításhoz a lejátszás ikon az aktuális változóértékekkel indít.
4. A validáció nem indít publish-t. Hiányzó token vagy futtatási hiba esetén a job hibás (`allow_failure: false`). A pipeline emiatt blokkoltnak/hibásnak látszhat; a publish csak a `parse_tokens` jobtól függ, nem a validációtól.
5. Az eltérések a job logjában, a `token-diff-report.json` a job artifactjai között találhatók. A riportot a runner hibás validáció után is feltölti, ha a validátor létre tudta hozni; megőrzés hét nap.

### Manuális CSS-publish és célmegadás

1. Nyisd meg azt a pipeline-t, amelynek a CSS-ét publikálni szeretnéd; a `parse_tokens` jobnak sikeresen le kell futnia.
2. Kattints a **`publish_tokens` job nevére**. Másik cél megadásához a job adatlapját nyisd meg, ne a közvetlen lejátszás ikont.
3. A változóűrlapon opcionálisan adj meg tetszőleges érvényes HTTPS Git clone URL-t (előzetes regisztráció nélkül):

   ```text
   Key: PUBLISH_TARGET_REPO_URL
   Value: https://github.com/example/frontend.git
   ```

4. Üres vagy kihagyott felülírásnál a konfigurált `TARGET_REPO_URL` használatos. A felülírás a **New pipeline** oldalon is megadható; a joboldali érték azt az adott publish-futtatásra felülírhatja.
5. Kattints a **Run job** gombra. Nincs szükség validáció indítására vagy sikeres validációs eredményre.
6. A job saját pipeline-jának CSS-artifactját publikálja az eddigi branch- és CSS-útvonalbeállításokkal. Lejárt artifact esetén előbb új CSS-generálást indíts.
7. A `publish_tokens` logjában találod az eredményt. A manuális job meglévő `allow_failure: true` beállítása megmarad: hibánál a job hibát jelez, de a teljes pipeline figyelmeztetéssel is befejeződhet. Mindig a publish job eredményét ellenőrizd.

A manuális változók más, jogosult projektfelhasználóknak is láthatók lehetnek. Ide csak nem titkos URL vagy ref kerülhet; tokent soha ne ezen az űrlapon adj meg. A jobváltozók kezelése a [GitLab manuális jobok dokumentációját](https://docs.gitlab.com/ci/jobs/job_control/) követi, új GitLab-verzióhoz kötött job input szintaxis nélkül.

### Szükséges GitLab-beállítások

A **Settings → CI/CD → Variables** alatt:

- `TARGET_REPO_URL`: a meglévő default cél; új beállításnál hitelesítési adatok nélküli HTTPS URL.
- `TARGET_REPO_USERNAME`, `TARGET_REPO_TOKEN`: külön hitelesítés; a tokent **Masked**, lehetőség szerint **Hidden** és **Protected** változóként tárold. Environment scope-ja lehet `publish-tokens`, mert a publish job ehhez az Environmenthez tartozik. Protected secret csak megfelelő védett refen érhető el.
- `TARGET_REPO_CREDENTIALS`: opcionális, egy sorban tárolt JSON-secret másik HTTPS-szerver hitelesítéséhez, a fenti formátumban. Használj **Masked**, lehetőség szerint **Hidden**, **Protected** és `publish-tokens` scope beállítást; az értékben kapcsold ki a változóhelyettesítést. A default- és hitelesítési változókat ne írd felül a manuális job űrlapján.
- `IDS_STYLES_REF`: a validáció alapértelmezett ids-styles branch/tag/SHA értéke; publish-hoz nem szükséges.
- A fenti táblázat opcionális `TARGET_REPO_BRANCH`, `TARGET_CSS_PATH`, checkout-, commit- és szerzőváltozói továbbra is használhatók.

GitLab célhoz a kiválasztott projekt(ek)re korlátozott project/group access token vagy megfelelően korlátozott PAT használható **write_repository** jogosultsággal. A hagyományos GitLab deploy token `read_repository` joga nem elegendő Git-pushhoz. A token mögötti felhasználó/bot szerepköre és a védett célbranch szabályai is engedjék az írást. A forrásprojekt `CI_JOB_TOKEN`-jét a publish nem küldi automatikusan másik repositorynak.

A publish futtatóit a `publish-tokens` protected Environmenttel korlátozd, ha a GitLab kiadás támogatja. Protected Environment hiányában csak védett forrásrefen adj ki Protected publish secreteket, és a branch merge-jogát korlátozd a megbízható publish-kezelőkre. A manuális jobváltozók külön felülírási lehetőséget jelentenek; a pipeline-változók minimum szerepköre önmagában nem védi ezeket. A pipeline-változók felülírásához szükséges minimum szerepkört állítsd megbízható maintainer/owner szintre; a felülírások jogát ne add a publish-hitelesítést nem kezelő felhasználóknak. Részletek: [GitLab CI/CD változók](https://docs.gitlab.com/ci/variables/).

A saját forrásrepositoryba történő CSS-visszacommitoláshoz külön engedélyezni kell a projekt saját `CI_JOB_TOKEN` push-jogát, vagy a meglévő masked `SELF_REPO_URL` konfiguráció használható. A publish célhitelesítése ettől külön működik.

## A tokenvalidáció riportjának értelmezése

Az összehasonlítás továbbra is kizárólag `--ids-comp-*` komponens-tokeneket vizsgál. A base és smc tokenek nem szerepelnek a darabszámokban vagy eltéréslistákban. A validátor a kiválasztott `ids-styles` refet checkoutolja, telepíti annak függőségeit, és az ottani build által készített CSS-ből olvassa ki a hivatkozásokat; a Sass ciklusok és interpolációk így már feloldottak.

- **Referenced by ids-styles but missing from generated CSS:** az ids-styles hivatkozik a tokenre, de nincs a generált CSS-ben. Nem üres lista esetén a validáció hibás.
- **Defined in generated CSS but not directly referenced by ids-styles:** definiált token, amelyre a kiválasztott ids-styles build nem hivatkozik közvetlenül. Információs lista; önmagában nem buktatja el a validációt, és nem bizonyítja, hogy a token minden fogyasztónál használatlan.

Mindkét lista egyedi neveket tartalmaz, alfabetikus sorrendben. Branch megadásával annak aktuális állapotát, taggel egy kiadást, teljes commit SHA-val pontosan rögzített verziót vizsgálhatsz. Hibás/hiányzó ref vagy buildhiba esetén a riport `error` mezővel készül el, és a validációs job hibával áll le.

## Tesztelés és ellenőrzési korlátok

```bash
npm ci
npm test
```

A tesztcsomag TypeScript-ellenőrzést, valódi ideiglenes Git-repositorykon clone/commit/push műveleteket, Git credential-protokolltesztet, a workflow-feltételek helyi kiértékelését és a validátor CLI-jának sikeres/hibás végigfuttatását tartalmazza. A validációs teszt egy lokális ids-styles fixture tagjét checkoutolja és buildeli; nem igényli az éles ids-styles repositoryt. A publish-tesztek kizárólag ideiglenes lokális célokra írnak. `file://` vagy abszolút helyi cél csak CI-n kívül, hitelesítési adatok nélkül használható; CI-ben ezek tiltottak.

A helyi workflow-tesztek nem helyettesítik a GitHub Actions runner és a GitLab scheduler tényleges futtatását. A távoli Environment-szabályok, projektjogosultságok, tokenek, SSH deploy key-k és a konkrét GitLab-verzió adminbeállításai csak a megfelelő platformon ellenőrizhetők. Éles publish nem része a tesztelésnek. Bevezetéskor külön tesztcélrepositoryval ellenőrizd a szervezeti jogosultságokat és a felületi jóváhagyást.
