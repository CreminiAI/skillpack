# </> SkillPack.sh - Pack AI Skills into Standalone Apps

Go to [skillpack.sh](https://skillpack.sh) to pack skills and try existing skill packs.

One command to orchestrate [Skills](https://skills.sh), tools, mcps into a standalone app users can download and use on their own computer!

```bash
npx skillpack create
```

If skills, tools, and MCPs are like LEGO pieces, a skill pack is the master piece that assembles them into a complete solution.

Each Skill Pack should organize different skills to address a well-defined problem or complete specific tasks. For example, research a company by gathering information from various sources and create a PowerPoint presentation based on the findings.

## Quick Start

### Create a Skill Pack Interactively

```bash
npx skillpack create
```

Step-by-Step

1. Set the Pack name and description
2. Add skills from a GitHub repos, URLs, or local paths
3. Add prompts to orchestrate and organize skills you added to accomplish tasks
4. (Optional) bundle the result as a zip

### Step-by-Step Commands

```bash
# Add skills
npx skillpack skills add vercel-labs/agent-skills --skill frontend-design
npx skillpack skills add ./my-local-skills

# Manage prompts
npx skillpack prompts add "Collect company data using Skill A, create charts from the data using Skill B, and compile the results into a PowerPoint using Skill C"
npx skillpack prompts list

# Package the current app
npx skillpack build
```

## Commands

| Command                  | Description                           |
| ------------------------ | ------------------------------------- |
| `create`                 | Create a skill pack interactively     |
| `skills add <source>`    | Add a skill                           |
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
├── app.json             # App configuration
├── skills/              # Collected SKILL.md files
├── server/              # Express backend
├── web/                 # Web chat UI
├── start.sh             # One-click launcher for macOS/Linux
├── start.bat            # One-click launcher for Windows
└── README.md
```

### Run the Skill Pack

```bash
# macOS / Linux
chmod +x start.sh && ./start.sh

# Windows
start.bat
```

Then open [http://127.0.0.1:26313](http://127.0.0.1:26313), enter your API key, and start working and having fun!!!

## Development

For development details, see [Development Guide](docs/development.md).

## License

MIT
