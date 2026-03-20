# SkillPack.sh - Pack AI Skills into Local Agents

Skillpack by Cremini is built on the idea of distributed intelligence, much like cremini mushrooms that grow from a vast, interconnected mycelial network.

Go to [skillpack.sh](https://skillpack.sh) to pack skills and try existing skill packs.

One command to orchestrate [Skills](https://skills.sh) and tools into a Local Agent that users can download and run it on their own computer to get work done. It can also connect to chat platforms like Slack or Telegram, allowing you to easily send instructions to your local agent team anytime.

```bash
npx @cremini/skillpack create
```

If skills and tools are like LEGO pieces, a skill pack is the master piece that assembles them into a complete solution.

Each Skill Pack should organize different skills to address a well-defined problem or complete specific tasks. For example, research a company by gathering information from various sources and create a PowerPoint presentation based on the findings.

## Quick Start

### Create a Skill Pack Interactively

```bash
npx @cremini/skillpack create
```

Step-by-Step

1. Set the Pack name and description
2. Add skills from a GitHub repos, URLs, or local paths
3. Add prompts to orchestrate and organize skills you added to accomplish tasks
4. (Optional) bundle the result as a zip

### Initialize with Configuration

```bash
npx @cremini/skillpack init --config ./skillpack.json
npx @cremini/skillpack init commic_explainer --config https://raw.githubusercontent.com/CreminiAI/skillpack/refs/heads/main/examples/commic_explainer.json
```

Bootstrap a SkillPack using a local file or remote URL.

### Step-by-Step Commands

```bash
# Add skills
npx @cremini/skillpack skills add vercel-labs/agent-skills --skill frontend-design
npx @cremini/skillpack skills add ./my-local-skills --skill local-helper

# Manage prompts
npx @cremini/skillpack prompts add "Collect company data using Skill A, create charts from the data using Skill B, and compile the results into a PowerPoint using Skill C"
npx @cremini/skillpack prompts list

# Package the current app
npx @cremini/skillpack build
```

## Commands

| Command                  | Description                           |
| ------------------------ | ------------------------------------- |
| `create`                 | Create a skill pack interactively     |
| `init`                   | Initialize from a config path or URL  |
| `skills add <source>`    | Add one or more skills with `--skill` |
| `skills remove <name>`   | Remove a skill                        |
| `skills list`            | List installed skills                 |
| `prompts add <text>`     | Add a prompt                          |
| `prompts remove <index>` | Remove a prompt                       |
| `prompts list`           | List all prompts                      |
| `build`                  | Package the skill pack as a zip file  |

## Zip Output

The extracted archive looks like this:

```text
skillpack/
├── skillpack.json       # Pack configuration
├── skills/              # Collected SKILL.md files
├── server/              # Runtime backend
├── web/                 # Runtime web UI
├── start.sh             # One-click launcher for macOS/Linux
├── start.bat            # One-click launcher for Windows
└── README.md            # Runtime guide
```

### Run the Skill Pack

```bash
# macOS / Linux
./start.sh

# Windows
start.bat
```

Running start.sh will open [http://127.0.0.1:26313](http://127.0.0.1:26313) in your browser. Just enter your API key to get started and enjoy!

## Development

For development details, see [Development Guide](docs/development.md).

## License

MIT
