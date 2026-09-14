//! Guess which programming language a file is written in.
//!
//! This is heavily based on GitHub's
//! [linguist](https://github.com/github/linguist/blob/master/docs/how-linguist-works.md),
//! particularly its
//! [languages.yml](https://github.com/github/linguist/blob/master/lib/linguist/languages.yml).
//!
//! Difftastic does not reuse languages.yml directly. Linguist has a
//! larger set of language detection strategies.

use std::borrow::Borrow;
use std::path::Path;

use lazy_static::lazy_static;
use regex::Regex;
use strum::{EnumIter, IntoEnumIterator};

/// Languages supported by difftastic. Each language here has a
/// corresponding tree-sitter parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter)]
pub(crate) enum Language {
    Asm,
    Bash,
    C,
    Clojure,
    CMake,
    CPlusPlus,
    CSharp,
    Css,
    Dockerfile,
    Elixir,
    EmacsLisp,
    Fish,
    Go,
    Haskell,
    Hcl,
    Html,
    Java,
    JavaScript,
    JavascriptJsx,
    Json,
    Lua,
    Make,
    Nix,
    ObjC,
    OCaml,
    OCamlInterface,
    Perl,
    Php,
    Proto,
    Python,
    Qml,
    Ruby,
    Rust,
    Scala,
    Sql,
    Swift,
    Toml,
    TypeScript,
    TypeScriptTsx,
    Xml,
    Yaml,
    Zig,
}

/// Users can explicitly request to treat a certain file glob pattern
/// as a specific languages, rather than using the normal language
/// detection logic.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum LanguageOverride {
    /// Treat the file as this language regardless of what language
    /// detection thinks.
    Language(Language),
    /// Treat this file as plain text.
    PlainText,
}

/// If there is a language called `name` (comparing case
/// insensitively), return it. Treat `"text"` as an additional option.
pub(crate) fn language_override_from_name(name: &str) -> Option<LanguageOverride> {
    let name = name.trim().to_lowercase();

    if name == "text" {
        return Some(LanguageOverride::PlainText);
    }

    for language in Language::iter() {
        let lang_name = language_name(language);
        if lang_name.to_lowercase() == name {
            return Some(LanguageOverride::Language(language));
        }
    }

    None
}

/// The language name shown to the user.
pub(crate) fn language_name(language: Language) -> &'static str {
    match language {
        Asm => "Assembly",
        Bash => "Bash",
        C => "C",
        Clojure => "Clojure",
        CMake => "CMake",
        CPlusPlus => "C++",
        CSharp => "C#",
        Css => "CSS",
        Dockerfile => "Dockerfile",
        Elixir => "Elixir",
        EmacsLisp => "Emacs Lisp",
        Fish => "Fish",
        Go => "Go",
        Haskell => "Haskell",
        Hcl => "HCL",
        Html => "HTML",
        Java => "Java",
        JavaScript => "JavaScript",
        JavascriptJsx => "JavaScript JSX",
        Json => "JSON",
        Lua => "Lua",
        Make => "Make",
        Nix => "Nix",
        ObjC => "Objective-C",
        OCaml => "OCaml",
        OCamlInterface => "OCaml Interface",
        Perl => "Perl",
        Php => "PHP",
        Proto => "Proto",
        Python => "Python",
        Qml => "QML",
        Ruby => "Ruby",
        Rust => "Rust",
        Scala => "Scala",
        Sql => "SQL",
        Swift => "Swift",
        Toml => "TOML",
        TypeScript => "TypeScript",
        TypeScriptTsx => "TypeScript TSX",
        Xml => "XML",
        Yaml => "YAML",
        Zig => "Zig",
    }
}

use Language::*;

use crate::lines::split_on_newlines;

/// File globs that identify languages based on the file path.
pub(crate) fn language_globs(language: Language) -> Vec<glob::Pattern> {
    let glob_strs: &'static [&'static str] = match language {
        Asm => &["*.asm", "*.s", "*.S"],
        Bash => &[
            "*.bash",
            "*.bats",
            "*.cgi",
            "*.command",
            "*.env",
            "*.fcgi",
            "*.ksh",
            "*.sh",
            "*.sh.in",
            "*.tmux",
            "*.tool",
            "*.zsh",
            ".bash_aliases",
            ".bash_history",
            ".bash_logout",
            ".bash_profile",
            ".bashrc",
            ".cshrc",
            ".env",
            ".env.example",
            ".flaskenv",
            ".kshrc",
            ".login",
            ".profile",
            ".zlogin",
            ".zlogout",
            ".zprofile",
            ".zshenv",
            ".zshrc",
            "9fs",
            "PKGBUILD",
            "bash_aliases",
            "bash_logout",
            "bash_profile",
            "bashrc",
            "cshrc",
            "gradlew",
            "kshrc",
            "login",
            "man",
            "profile",
            "zlogin",
            "zlogout",
            "zprofile",
            "zshenv",
            "zshrc",
        ],
        C => &["*.c"],
        Clojure => &[
            "*.bb", "*.boot", "*.clj", "*.cljc", "*.clje", "*.cljs", "*.cljx", "*.edn", "*.joke",
            "*.joker",
        ],
        CMake => &["*.cmake", "*.cmake.in", "CMakeLists.txt"],
        // Treat .h as C++ rather than C. This is an arbitrary choice, but
        // C++ is more widely used than C according to
        // https://madnight.github.io/githut/
        // Also, treating CUDA as C++
        CPlusPlus => &[
            "*.cc", "*.cpp", "*.c++", "*.cxx", "*.cu", "*.h", "*.hh", "*.hpp", "*.hxx", "*.inl",
            "*.ino", "*.ipp", "*.ixx", "*.tcc",
        ],
        CSharp => &["*.cs"],
        Css => &["*.css"],
        Dockerfile => &[
            "Dockerfile",
            "Containerfile",
            "Dockerfile.*",
            "*.dockerfile",
            "*.containerfile",
        ],
        EmacsLisp => &["*.el", ".emacs", "_emacs", "Cask"],
        Elixir => &["*.ex", "*.exs"],
        Fish => &["*.fish"],
        Go => &["*.go"],
        Haskell => &["*.hs"],
        Hcl => &["*.hcl", "*.nomad", "*.tf", "*.tfvars", "*.workflow"],
        Html => &["*.html", "*.htm", "*.xhtml"],
        Java => &["*.java"],
        JavaScript => &["*.cjs", "*.js", "*.mjs", "*.snap"],
        Json => &[
            "*.json",
            "*.avsc",
            "*.geojson",
            "*.gltf",
            "*.har",
            "*.ice",
            "*.ipynb",
            "*.JSON-tmLanguage",
            "*.jsonl",
            "*.mcmeta",
            "*.tfstate",
            "*.tfstate.backup",
            "*.topojson",
            "*.webapp",
            "*.webmanifest",
            ".arcconfig",
            ".auto-changelog",
            ".c8rc",
            ".htmlhintrc",
            ".imgbotconfig",
            ".nycrc",
            ".tern-config",
            ".tern-project",
            ".watchmanconfig",
            "Pipfile.lock",
            "composer.lock",
            "mcmod.info",
            "flake.lock",
        ],
        JavascriptJsx => &["*.jsx"],
        Lua => &["*.lua"],
        Make => &[
            "*.mak",
            "*.d",
            "*.make",
            "*.makefile",
            "*.mk",
            "*.mkfile",
            "BSDmakefile",
            "GNUmakefile",
            "Kbuild",
            "Makefile",
            "Makefile.am",
            "Makefile.boot",
            "Makefile.frag",
            "Makefile*.in",
            "Makefile.inc",
            "Makefile.wat",
            "makefile",
            "makefile.sco",
            "mkfile",
        ],
        Nix => &["*.nix"],
        ObjC => &["*.m"],
        OCaml => &["*.ml"],
        OCamlInterface => &["*.mli"],
        Perl => &["*.pm", "*.pl"],
        Php => &[
            "*.php", "*.phtml", "*.php3", "*.php4", "*.php5", "*.php7", "*.phps",
        ],
        Proto => &["*.proto"],
        Python => &["*.py", "*.py3", "*.pyi", "*.bzl", "TARGETS", "BUCK", "DEPS"],
        Qml => &["*.qml"],
        Ruby => &[
            "*.rb",
            "*.builder",
            "*.spec",
            "*.rake",
            "Gemfile",
            "Rakefile",
        ],
        Rust => &["*.rs"],
        Scala => &["*.scala", "*.sbt", "*.sc"],
        Sql => &["*.sql", "*.pgsql"],
        Swift => &["*.swift"],
        Toml => &[
            "*.toml",
            "Cargo.lock",
            "Gopkg.lock",
            "Pipfile",
            "pdm.lock",
            "poetry.lock",
            "uv.lock",
        ],
        TypeScript => &["*.ts", "*.cts", "*.mts"],
        TypeScriptTsx => &["*.tsx"],
        Xml => &[
            "*.ant",
            "*.csproj",
            // Following GitHub, treat MJML as XML.
            // https://documentation.mjml.io/
            "*.mjml",
            "*.plist",
            "*.resx",
            "*.svg",
            "*.ui",
            "*.vbproj",
            "*.xaml",
            "*.xml",
            "*.xsd",
            "*.xsl",
            "*.xslt",
            "*.zcml",
            "App.config",
            "nuget.config",
            "packages.config",
            ".classpath",
            ".cproject",
            ".project",
        ],
        Yaml => &["*.yaml", "*.yml", "yarn.lock", "CITATION.cff"],
        Zig => &["*.zig"],
    };

    glob_strs
        .iter()
        .map(|name| {
            glob::Pattern::new(name).expect("Glob in difftastic source should be well-formed")
        })
        .collect()
}

fn looks_like_hacklang(path: &Path, src: &str) -> bool {
    if let Some(extension) = path.extension() {
        if extension == "php" && src.starts_with("<?hh") {
            return true;
        }
    }

    false
}

/// Use a heuristic to determine if a '.h' file looks like Objective-C.
/// We look for a line starting with '#import', '@interface' or '@protocol'
/// near the top of the file.  These keywords are not valid C or C++, so this
/// should not produce false positives.
fn looks_like_objc(path: &Path, src: &str) -> bool {
    if let Some(extension) = path.extension() {
        if extension == "h" {
            return split_on_newlines(src).take(100).any(|line| {
                ["#import", "@interface", "@protocol"]
                    .iter()
                    .any(|keyword| line.starts_with(keyword))
            });
        }
    }

    false
}

fn looks_like_xml(src: &str) -> bool {
    src.starts_with("<?xml")
}

pub(crate) fn guess(
    path: &Path,
    src: &str,
    overrides: &[(LanguageOverride, Vec<glob::Pattern>)],
) -> Option<Language> {
    if let Some(file_name) = path.file_name() {
        let file_name = file_name.to_string_lossy();
        for (lang_override, patterns) in overrides {
            for pattern in patterns {
                if pattern.matches(&file_name) {
                    match lang_override {
                        LanguageOverride::Language(lang) => return Some(*lang),
                        LanguageOverride::PlainText => {
                            return None;
                        }
                    }
                }
            }
        }
    }

    if let Some(lang) = from_emacs_mode_header(src) {
        return Some(lang);
    }
    if let Some(lang) = from_shebang(src) {
        return Some(lang);
    }

    // Handle cases where file detection should override globbing,
    // specifically *.php as potentially Hack or *.h as potentially
    // Objective-C.
    if looks_like_hacklang(path, src) {
        return None;
    }
    if looks_like_objc(path, src) {
        return Some(Language::ObjC);
    }

    if let Some(lang) = from_glob(path) {
        return Some(lang);
    }

    if looks_like_xml(src) {
        return Some(Language::Xml);
    }

    None
}

/// Try to guess the language based on an Emacs mode comment at the
/// beginning of the file.
///
/// <https://www.gnu.org/software/emacs/manual/html_node/emacs/Choosing-Modes.html>
/// <https://www.gnu.org/software/emacs/manual/html_node/emacs/Specifying-File-Variables.html>
fn from_emacs_mode_header(src: &str) -> Option<Language> {
    lazy_static! {
        static ref MODE_RE: Regex = Regex::new(r"-\*- *mode: *([a-zA-Z0-9_+-]+).*-\*-").unwrap();
        static ref SHORTHAND_RE: Regex = Regex::new(r"-\*-(.+)-\*-").unwrap();
    }

    // Emacs allows the mode header to occur on the second line if the
    // first line is a shebang.
    for line in split_on_newlines(src).take(2) {
        let mode_name: String = match (MODE_RE.captures(line), SHORTHAND_RE.captures(line)) {
            (Some(cap), _) | (_, Some(cap)) => cap[1].into(),
            _ => "".into(),
        };
        return Some(match mode_name.to_ascii_lowercase().trim() {
            "c" => C,
            "clojure" => Clojure,
            "csharp" => CSharp,
            "css" => Css,
            "c++" => CPlusPlus,
            "elixir" => Elixir,
            "emacs-lisp" => EmacsLisp,
            "fish" => Fish,
            "go" => Go,
            "haskell" => Haskell,
            "hcl" => Hcl,
            "html" => Html,
            "java" => Java,
            "js" | "js2" => JavaScript,
            "nxml" => Xml,
            "objc" => ObjC,
            "perl" => Perl,
            "python" => Python,
            "rjsx" => JavascriptJsx,
            "ruby" => Ruby,
            "rust" => Rust,
            "scala" => Scala,
            "sh" => Bash,
            "sql" => Sql,
            "swift" => Swift,
            "toml" => Toml,
            "tuareg" => OCaml,
            "typescript" => TypeScript,
            "yaml" => Yaml,
            "zig" => Zig,
            _ => continue,
        });
    }

    None
}

/// Try to guess the language based on a shebang present in the source.
fn from_shebang(src: &str) -> Option<Language> {
    lazy_static! {
        static ref RE: Regex = Regex::new(r"^#! *(?:/usr/bin/env )?([^ ]+)").unwrap();
    }
    if let Some(first_line) = split_on_newlines(src).next() {
        if let Some(cap) = RE.captures(first_line) {
            let interpreter_path = Path::new(&cap[1]);
            if let Some(name) = interpreter_path.file_name() {
                match name.to_string_lossy().borrow() {
                    "ash" | "bash" | "dash" | "ksh" | "mksh" | "pdksh" | "rc" | "sh" | "zsh" => {
                        return Some(Bash)
                    }
                    "tcc" => return Some(C),
                    "elixir" => return Some(Elixir),
                    "fish" => return Some(Fish),
                    "runghc" | "runhaskell" | "runhugs" => return Some(Haskell),
                    "chakra" | "d8" | "gjs" | "js" | "node" | "nodejs" | "qjs" | "rhino" | "v8"
                    | "v8-shell" => return Some(JavaScript),
                    "ocaml" | "ocamlrun" | "ocamlscript" => return Some(OCaml),
                    "perl" => return Some(Perl),
                    "python" | "python2" | "python3" => return Some(Python),
                    "ruby" | "macruby" | "rake" | "jruby" | "rbx" => return Some(Ruby),
                    "swift" => return Some(Swift),
                    "deno" | "ts-node" => return Some(TypeScript),
                    _ => {}
                }
            }
        }
    }

    None
}

fn from_glob(path: &Path) -> Option<Language> {
    match path.file_name() {
        Some(name) => {
            let name = name.to_string_lossy().into_owned();
            for language in Language::iter() {
                for glob in language_globs(language) {
                    if glob.matches(&name) {
                        return Some(language);
                    }
                }
            }

            None
        }
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn test_guess_by_extension() {
        let path = Path::new("foo.el");
        assert_eq!(guess(path, "", &[]), Some(EmacsLisp));
    }

    #[test]
    fn test_guess_cplusplus_cplusplus_extension() {
        // Regression: the `.c++` extension glob was missing its leading `*`
        // (introduced in 286cad721), so foo.c++ fell through to plain text.
        let path = Path::new("foo.c++");
        assert_eq!(guess(path, "", &[]), Some(CPlusPlus));
    }

    #[test]
    fn test_guess_by_whole_name() {
        let path = Path::new("foo/.bashrc");
        assert_eq!(guess(path, "", &[]), Some(Bash));
    }

    #[test]
    fn test_guess_by_shebang() {
        let path = Path::new("foo");
        assert_eq!(guess(path, "#!/bin/bash", &[]), Some(Bash));
    }

    #[test]
    fn test_guess_by_env_shebang() {
        let path = Path::new("foo");
        assert_eq!(guess(path, "#!/usr/bin/env python", &[]), Some(Python));
    }

    #[test]
    fn test_guess_by_shebang_with_space() {
        let path = Path::new("foo");
        assert_eq!(guess(path, "#! /bin/sh", &[]), Some(Bash));
    }

    #[test]
    fn test_guess_comment_not_shebang() {
        let path = Path::new("foo.py");
        assert_eq!(guess(path, "bar = 1 #!/bin/bash", &[]), Some(Python));
    }

    #[test]
    fn test_guess_by_emacs_mode_simple() {
        let path = Path::new("foo");
        assert_eq!(guess(path, "; -*- mode: Clojure -*-", &[]), Some(Clojure));
    }

    #[test]
    fn test_guess_by_emacs_mode() {
        let path = Path::new("foo");
        assert_eq!(
            guess(path, "; -*- mode: Clojure; eval: (auto-fill-mode 1); -*-", &[]),
            Some(Clojure)
        );
    }

    #[test]
    fn test_guess_by_emacs_mode_second_line() {
        let path = Path::new("foo");
        assert_eq!(
            guess(path, "#!/bin/bash\n; -*- mode: Clojure; -*-", &[]),
            Some(Clojure)
        );
    }

    #[test]
    fn test_guess_by_emacs_mode_shorthand() {
        let path = Path::new("foo");
        assert_eq!(guess(path, "(* -*- tuareg -*- *)", &[]), Some(OCaml));
    }

    #[test]
    fn test_guess_by_emacs_mode_shorthand_no_spaces() {
        let path = Path::new("foo");
        assert_eq!(guess(path, "# -*-python-*-", &[]), Some(Python));
    }

    #[test]
    fn test_guess_by_xml_header() {
        let path = Path::new("foo");
        assert_eq!(
            guess(path, "<?xml version=\"1.0\" encoding=\"utf-8\"?>", &[]),
            Some(Xml)
        );
    }

    #[test]
    fn test_guess_unknown() {
        let path = Path::new("jfkdlsjfkdsljfkdsljf");
        assert_eq!(guess(path, "", &[]), None);
    }

    #[test]
    fn test_guess_override() {
        let path = Path::new("foo.el");
        assert_eq!(
            guess(
                path,
                "",
                &[(
                    LanguageOverride::Language(Css),
                    vec![glob::Pattern::new("*.el").unwrap()],
                )]
            ),
            Some(Css)
        );
    }
}
