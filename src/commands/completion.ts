import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function completionCommand(shell: string): Promise<void> {
  if (shell !== 'bash' && shell !== 'zsh') {
    console.error('Error: Shell must be either "bash" or "zsh"');
    process.exit(1);
  }

  const script = shell === 'bash' ? generateBashCompletion() : generateZshCompletion();
  console.log(script);
}

function generateBashCompletion(): string {
  return `# Ralph CLI bash completion

_ralph_completion() {
  local cur prev commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="start status list stop merge update retry logs batch-start config runner stats completion"
  
  case "\${prev}" in
    ralph)
      COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
      return 0
      ;;
    start)
      # Complete PRD file paths
      COMPREPLY=( $(compgen -f -X '!*.md' -- \${cur}) )
      return 0
      ;;
    status|stop|merge|logs|stats)
      # Complete task IDs from state
      local task_ids=$(ralph list 2>/dev/null | grep -oE 'task-[0-9]+-[a-z0-9]+' | sort -u)
      COMPREPLY=( $(compgen -W "\${task_ids}" -- \${cur}) )
      return 0
      ;;
    --repo)
      # Complete directory paths
      COMPREPLY=( $(compgen -d -- \${cur}) )
      return 0
      ;;
    --agent)
      COMPREPLY=( $(compgen -W "claude codex" -- \${cur}) )
      return 0
      ;;
    --status)
      COMPREPLY=( $(compgen -W "pending running completed failed stagnant" -- \${cur}) )
      return 0
      ;;
    --strategy)
      COMPREPLY=( $(compgen -W "ours theirs manual" -- \${cur}) )
      return 0
      ;;
    --format)
      COMPREPLY=( $(compgen -W "json table summary" -- \${cur}) )
      return 0
      ;;
  esac

  # Complete options
  case "\${cur}" in
    -*)
      local opts="--repo --agent --status --auto --strategy --target --follow --lines --format --all --help"
      COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
      return 0
      ;;
  esac
}

complete -F _ralph_completion ralph
`;
}

function generateZshCompletion(): string {
  return `#compdef ralph
# Ralph CLI zsh completion

_ralph() {
  local -a commands
  commands=(
    'start:Start a new task from a PRD file'
    'status:Show status of a task or all running tasks'
    'list:List all tasks'
    'stop:Stop a running task'
    'merge:Merge a completed task'
    'logs:View task execution logs'
    'stats:Show performance statistics for a task'
    'completion:Generate shell completion script'
  )

  local -a task_ids
  task_ids=(\${(f)"$(ralph list 2>/dev/null | grep -oE 'task-[0-9]+-[a-z0-9]+' | sort -u)"})

  _arguments -C \\
    '1: :->command' \\
    '*:: :->args'

  case $state in
    command)
      _describe 'ralph commands' commands
      ;;
    args)
      case $words[1] in
        start)
          _arguments \\
            '1:PRD file:_files -g "*.md"' \\
            '--repo[Repository path]:directory:_directories' \\
            '--agent[Agent to use]:agent:(claude codex)'
          ;;
        status|stop|merge|logs|stats)
          _arguments \\
            "1:task ID:(\${task_ids})" \\
            '--auto[Auto-resolve conflicts]' \\
            '--strategy[Conflict resolution strategy]:strategy:(ours theirs manual)' \\
            '--target[Target branch]:branch:' \\
            '--follow[Follow log output]' \\
            '--lines[Number of lines]:lines:' \\
            '--format[Output format]:format:(json table summary)' \\
            '--all[Show stats for all tasks]'
          ;;
        list)
          _arguments \\
            '--status[Filter by status]:status:(pending running completed failed stagnant)'
          ;;
        completion)
          _arguments \\
            '1:shell:(bash zsh)'
          ;;
      esac
      ;;
  esac
}

_ralph "$@"
`;
}
