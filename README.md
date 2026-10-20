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

## Publikálási cél: default és mentett profil

A publish kétféle, előre konfigurált URL–token párt tud kiválasztani. A cél URL-je külön, látható változóban tárolható és javítható; a token CI-secretben tárolandó. A publish célválasztó paramétere csak a profilnév; az URL és a token a mentett konfigurációból érkezik. A `CREDENTIALS` értéke minden esetben **a nyers token**, nem JSON és nem hitelesítést tartalmazó URL.

| Mód | URL | Token | Indításkor megadandó |
|-----|-----|-------|---------------------|
| Default | `DEFAULT_TARGET_REPO_URL` változó | `DEFAULT_TARGET_REPO_CREDENTIALS` secret | Üres profilnév |
| Mentett profil, például `DEMO` | `DEMO_TARGET_REPO_URL` változó | `DEMO_TARGET_REPO_CREDENTIALS` secret | Profilnév: `DEMO` |

A default vagy profil opcionális HTTPS-felhasználóneve a `DEFAULT_TARGET_REPO_USERNAME`, illetve `<PROFIL>_TARGET_REPO_USERNAME` látható változóban adható meg. Ha a kiválasztott párhoz nincs felhasználónév megadva, az alapérték `git`; ez GitHub és GitLab personal access tokenekkel használható. Olyan tokennél, amely konkrét felhasználónevet igényel, add meg azt a kiválasztott cél saját username-mezőjében.

### Alapértelmezett pár

A CI beállításaiban egyszer hozd létre:

```text
Változó: DEFAULT_TARGET_REPO_URL = https://github.com/example/frontend.git
Secret:  DEFAULT_TARGET_REPO_CREDENTIALS = a célhoz tartozó nyers token
```

Ha publishkor a profilnév üres, ide történik a publikálás. A default párt mentett profil kiválasztásakor nem szükséges konfigurálni.

### Több mentett profil

Minden profilhoz önálló változó–secret párost hozz létre, például:

```text
Változó: DEMO_TARGET_REPO_URL = https://github.com/example/demo-frontend.git
Secret:  DEMO_TARGET_REPO_CREDENTIALS = a demo repository tokenje

Változó: SANDBOX_TARGET_REPO_URL = https://gitlab.example.com/team/sandbox-frontend.git
Secret:  SANDBOX_TARGET_REPO_CREDENTIALS = a sandbox repository tokenje
```

Indításkor csak a `DEMO` vagy `SANDBOX` profilnevet add meg. A profilnév nagybetűvel kezdődik, és kizárólag `A–Z`, `0–9`, `_` karaktereket tartalmazhat. A rendszer a név alapján választja ki a hozzá tartozó URL-t és tokent. Új profilhoz elég létrehozni a megfelelő CI-változókat és secreteket; nincs központi profillista, kódmódosítás vagy URL-allowlist. A profil URL-je a token újramentése nélkül módosítható.

### Kiválasztási szabályok és hibák

- Üres profilnév: a teljes default pár használatos.
- Megadott profil: kizárólag annak saját URL-je, tokenje és opcionális felhasználóneve használatos.
- Ismeretlen, hibás nevű vagy hiányosan konfigurált profil: hiba, default fallback nélkül.
- Hibás URL, hiányzó token vagy elégtelen Git-jogosultság: a publish hibával leáll.

Nincs credential fallback a default és a profilok között, és sikertelen Git-művelet után nincs másik hitelesítéssel történő újrapróbálkozás. A default vagy mentett profil konfigurációjában tetszőleges érvényes HTTPS clone URL használható. Az URL nem tartalmazhat tokent, jelszót, felhasználónevet, queryt vagy fragmentet. A script a szolgáltató clone útvonalát használja, nem fűz hozzá automatikusan `.git` végződést.

### Hitelesítés, naplózás és megmaradó beállítások

A kiválasztott tokennek a konkrét célrepositoryhoz olvasási és írási jog kell. A Git-szerver ellenőrzi a tényleges jogosultságot; a token létezése önmagában nem jogosít pushra. A célbranch védelmi szabályait is be kell tartani.

A naplóban látható a választott mód, a profil neve, a cél-URL, a credential-beállítás **neve**, a branch és a CSS-könyvtár. A token értékét a script nem naplózza. A token a Git credential protokollján, csak a kiválasztott HTTPS hosthoz és repositoryútvonalhoz kerül átadásra; nem kerül clone URL-be, Git-konfigurációba vagy parancssori argumentumba. A HTTP-átirányítások, örökölt credential helperek, HTTP fejlécek, URL-átírások és Git trace kimenet tiltottak. A TLS-ellenőrzés aktív; belső CA esetén `GIT_SSL_CAINFO` használható. A célrepository nyers hibakimenete helyett a script ellenőrzési útmutatót adó hibaüzenetet ír.

| Változó | Alapérték / jelentés |
|---------|---------------------|
| `TARGET_REPO_BRANCH` | `IDS_CSS`; szükség esetén létrejön a branch |
| `TARGET_CSS_PATH` | `projects/demo/src/assets/ids_css` |
| `TARGET_CHECKOUT_DIR` | `target-repo`; biztonságos relatív helyi könyvtár |
| `TARGET_COMMIT_MESSAGE` | `chore(tokens): update generated CSS` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | GitLab/helyi fallback: `token-pipeline`, `token-pipeline@example.invalid`; GitHubon a workflow botazonosítót ad |

Ezek a beállítások mindkét célválasztási módban azonosak. A script csak a cél CSS-könyvtár tartalmát cseréli le. Más célfájlok megmaradnak; azonos CSS esetén nincs új commit vagy push. A checkout- és célútvonalak nem vezethetnek ki a repositoryból és nem haladhatnak át szimbolikus linken.

### Átállás a korábbi publish-konfigurációról

Ez a célválasztás **nem visszafelé kompatibilis**. A korábbi beállítások nem szolgálnak fallbackként.

| Korábbi beállítás | Új beállítás |
|------------------|-------------|
| `TARGET_REPO_URL` | `DEFAULT_TARGET_REPO_URL`, csak a hitelesítés nélküli URL |
| `TARGET_REPO_TOKEN`, illetve az URL-be ágyazott token | `DEFAULT_TARGET_REPO_CREDENTIALS`, csak a nyers token |
| `TARGET_REPO_USERNAME`, illetve az URL-be ágyazott username | Opcionális `DEFAULT_TARGET_REPO_USERNAME` |
| `TARGET_REPO_CREDENTIALS` JSON | A token a default vagy a választott profil `…_CREDENTIALS` secretjébe; az URL külön látható változóba kerül |
| `PUBLISH_TARGET_REPO_URL`, GitHubon `target_repo_url` | Előre konfigurált mentett profil választása |

Az új beállítások létrehozása után a régi cél- és hitelesítési változók törölhetők. A mentett default- és profiltokeneket a CI secretkezelőjében add meg. Az új publish-párok HTTPS URL-t és tokent használnak; a korábbi SSH-default konfigurációt is erre kell átállítani. Az `IDS_STYLES_REF`, a parser és a forrásrepository CSS-visszacommitolásának beállításai változatlanok.

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

### Manuális CSS-publish: default vagy mentett profil

1. Nyisd meg az **Actions → Token Pipeline → Run workflow** felületet, válaszd a token-store forrásbranchét/tagjét és az `operation: publish` értéket.
2. Válassz az alábbi kitöltések közül:

   | Mód | `target_profile` |
   |-----|------------------|
   | Default | üres |
   | Mentett profil | például `DEMO` |

3. Kattints a **Run workflow** gombra. Az URL-t és a tokent a rendszer a kiválasztott cél előre konfigurált Variable/Secret párjából olvassa.
4. A CSS-generálás után, ha van Environment-jóváhagyás, a **Review deployments** felületen hagyd jóvá a `publish-tokens` telepítést.
5. A **Publish CSS** job a futtatás saját CSS-artifactját publikálja. A job naplója mutatja a módot, profilnevet, URL-t, credential-beállítás nevét, branchet és célkönyvtárat.
6. A job logjában találod a sikert, a változatlan CSS jelzését vagy a hibát. Sikertelen publish hibás jobot és hibás workflow-futtatást eredményez. Az `ids_styles_ref` ehhez nem szükséges.

### Szükséges GitHub-beállítások

A **Settings → Secrets and variables → Actions** felületen, vagy a `publish-tokens` Environmentben:

- **Variables:** `DEFAULT_TARGET_REPO_URL`, illetve minden mentett profil saját `<PROFIL>_TARGET_REPO_URL` értéke. Az opcionális username ugyanilyen előtagú `…_TARGET_REPO_USERNAME` változó. Az URL-eket ne Secretként tárold, mert a workflow a `vars` kontextusból olvassa őket.
- **Secrets:** `DEFAULT_TARGET_REPO_CREDENTIALS`, illetve például `DEMO_TARGET_REPO_CREDENTIALS`, `SANDBOX_TARGET_REPO_CREDENTIALS`. Mindegyik érték a megfelelő repository nyers tokenje. A defaultot és minden profilt csak egyszer kell felvenni; publishkor nem kell átírni a meglévő secreteket.
- **További Variables:** `IDS_STYLES_REF`, valamint a közös `TARGET_REPO_BRANCH`, `TARGET_CSS_PATH`, checkout-, commit- és szerzőbeállítások.
- **Environments:** `publish-tokens` és `validate-ids-styles`. A Required reviewers további jóváhagyást adhatnak; a manuális publish működése nem függ ettől. A publishhoz használt mentett secreteket célszerű a `publish-tokens` Environmenthez és ellenőrzött branchekhez kötni.
- A forrásrepositoryba történő CSS-visszacommitoláshoz a `parse_tokens` job `GITHUB_TOKEN`-je `contents: write` jogot kér; a célrepository tokenje ettől külön működik.

GitHub célhoz a kiválasztott repositoryhoz jogosított fine-grained PAT **Contents: Read and write** joggal, vagy megfelelő GitHub App token használható. A szervezeti jóváhagyási és SSO-szabályoknak is teljesülniük kell. GitLab célhoz GitLab által kiadott, megfelelően korlátozott token kell.

A profilnév alapján a workflow csak a kiválasztott URL-változót és credential-secretet adja át a közös publish scriptnek. A mentett profil URL-jének javításához a megfelelő Variable-t módosítsd, a tokent tartalmazó Secretet nem kell újramenteni.

A **Run workflow** felület a default branchre felkerült workflow-hoz érhető el; a helyi fájlmódosítás önmagában nem frissíti ezt a felületet.

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

### Manuális CSS-publish: default vagy mentett profil

1. Nyisd meg azt a pipeline-t, amelynek a CSS-ét publikálni szeretnéd. A `parse_tokens` jobnak sikeresen le kell futnia.
2. Kattints a **`publish_tokens` job nevére**. Paraméterek megadásához a job adatlapját nyisd meg, ne a közvetlen lejátszás ikont.
3. A változóűrlapot az alábbiak szerint töltsd ki:

   | Mód | Jobváltozók |
   |-----|-------------|
   | Default | Hagyd üresen a `PUBLISH_TARGET_PROFILE` értékét |
   | Mentett profil | `PUBLISH_TARGET_PROFILE = DEMO` |

4. Kattints a **Run job** gombra. Az URL és a token a kiválasztott cél előre konfigurált CI/CD-változóiból érkezik; a tokent ne add meg a manuális űrlapon.
5. A job a saját pipeline-jának CSS-artifactját publikálja a közös branch- és könyvtárbeállításokkal. Lejárt artifact esetén indíts új CSS-generálást. Validáció indítása vagy sikere nem előfeltétel.
6. A naplóban a választott mód, profilnév, URL, credential-beállítás neve, branch és célkönyvtár látható. A script a token értékét nem írja ki. Az eredményt és a hibát is itt találod.

A `PUBLISH_TARGET_PROFILE` a **New pipeline** oldalon is megadható; a joboldali érték az adott publish-futtatásra felülírhatja. Default publishhoz hagyd üresen a profilnevet; retrykor ellenőrizd az esetleg előre kitöltött korábbi profilválasztást.

A meglévő `allow_failure: true` megmarad: sikertelen publish esetén a job hibát jelez, de a teljes pipeline figyelmeztetéssel is befejeződhet. Mindig a publish job eredményét ellenőrizd. A manuális változóűrlap működését a [GitLab dokumentációja](https://docs.gitlab.com/ci/jobs/job_control/) részletezi.

### Szükséges GitLab-beállítások

A **Settings → CI/CD → Variables** alatt:

- **Default:** `DEFAULT_TARGET_REPO_URL` látható változó és `DEFAULT_TARGET_REPO_CREDENTIALS` **Masked**, lehetőség szerint **Hidden** tokenváltozó.
- **Profilok:** például `DEMO_TARGET_REPO_URL` látható változó és `DEMO_TARGET_REPO_CREDENTIALS` **Masked**, lehetőség szerint **Hidden** tokenváltozó. További profilhoz ugyanilyen névpárt hozz létre; nincs szükség `.gitlab-ci.yml` módosítására.
- **Username:** szükség esetén `DEFAULT_TARGET_REPO_USERNAME` vagy `<PROFIL>_TARGET_REPO_USERNAME`, látható változóként.
- A tokenváltozók típusa **Variable** legyen, ne **File**. Kapcsold ki az **Expand variable reference** opciót, hogy a token pontos értéke érkezzen meg. Environment scope lehet `publish-tokens`. **Protected** változó csak megfelelő védett refen érhető el.
- `IDS_STYLES_REF`: a validáció alapértelmezett ids-styles branch/tag/SHA értéke. Publishhoz nem szükséges.
- A közös `TARGET_REPO_BRANCH`, `TARGET_CSS_PATH`, checkout-, commit- és szerzőváltozók továbbra is használhatók.

GitLab célhoz a kiválasztott projekt(ek)re korlátozott project/group access token vagy megfelelő PAT használható **write_repository** jogosultsággal. A hagyományos GitLab deploy token `read_repository` joga nem elegendő Git-pushhoz; a konkrét deploy/bot username szükség esetén külön beállítandó. A védett célbranch szabályai is engedjék az írást. GitHub célhoz annak saját tokenje kell. A forrásprojekt `CI_JOB_TOKEN`-je nem szolgál célhitelesítési fallbackként.

A mentett pár URL-jét a megfelelő látható `…_TARGET_REPO_URL` változóban javítsd; a tokenhez nem kell hozzányúlni. A default- és profilbeállításokat megbízható maintainerek kezeljék. A manuális jobváltozók felülírhatják a projektváltozókat, ezért a publish futtatásának joga és a védett secretekhez való hozzáférés csak megbízható szerepköröknél legyen. Használj protected Environmentet, ha a GitLab kiadás támogatja; egyébként Protected secreteket és megfelelően korlátozott védett forrásbrancheket. A pipeline-változók minimum szerepköre önmagában nem védi a manuális jobfelülírásokat. [GitLab CI/CD változók](https://docs.gitlab.com/ci/variables/)

A saját forrásrepositoryba történő CSS-visszacommitoláshoz továbbra is külön engedélyezni kell a projekt saját `CI_JOB_TOKEN` push-jogát, vagy használható a meglévő masked `SELF_REPO_URL`. Ez a célrepositoryba történő publikálástól külön működik.

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

A tesztcsomag TypeScript-ellenőrzést, a default/profil módok kiválasztását és hibáit, valódi ideiglenes Git-repositorykon clone/commit/push műveleteket mindkét módban, Git credential-protokolltesztet, a workflow-feltételek helyi kiértékelését és a validátor CLI-jának sikeres/hibás végigfuttatását tartalmazza. A validációs teszt egy lokális ids-styles fixture tagjét checkoutolja és buildeli; nem igényli az éles ids-styles repositoryt. A publish-tesztek kizárólag ideiglenes lokális célokra írnak. `file://` vagy abszolút helyi cél csak CI-n kívül, hitelesítési adatok nélkül használható; CI-ben ezek tiltottak.

A helyi workflow-tesztek nem helyettesítik a GitHub Actions runner és a GitLab scheduler tényleges futtatását. A távoli Environment-szabályok, projektjogosultságok, tokenek és a konkrét GitLab-verzió adminbeállításai csak a megfelelő platformon ellenőrizhetők. Éles publish nem része a tesztelésnek. Bevezetéskor külön tesztcélrepositoryval ellenőrizd a szervezeti jogosultságokat és a felületi jóváhagyást.
