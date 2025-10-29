# This script automates the process of updating Git submodules.
# It reads the submodule configuration from the .gitmodules file,
# checks out the specified branch for each submodule, and commits any changes.

# Get the content of the .gitmodules file in the current directory.
try {
    $gitmodulesContent = Get-Content .\.gitmodules -Raw
}
catch {
    Write-Error "Error: Could not find or read the .gitmodules file in the current directory."
    # Exit the script if the .gitmodules file cannot be read.
    return
}

# Split the content into individual submodule sections using a regular expression.
# This looks for the start of a [submodule] block.
$submoduleSections = $gitmodulesContent -split '(?=\[submodule)' | ForEach-Object { $_.Trim() } | Where-Object { $_ }

# Loop through each submodule section found in the .gitmodules file.
foreach ($section in $submoduleSections) {
    # Use regular expressions to extract the path and branch for the submodule.
    $pathMatch = [regex]::Match($section, 'path\s*=\s*(.*)')
    $branchMatch = [regex]::Match($section, 'branch\s*=\s*(.*)')

    # Proceed only if both path and branch were successfully extracted.
    if ($pathMatch.Success -and $branchMatch.Success) {
        # Trim any leading/trailing whitespace from the extracted values.
        $path = $pathMatch.Groups[1].Value.Trim()
        $branch = $branchMatch.Groups[1].Value.Trim()

        Write-Host "Processing submodule at path: $path"

        # Verify that the submodule directory exists before trying to enter it.
        if (Test-Path -Path $path -PathType Container) {
            # Save the current location and change directory to the submodule's path.
            Push-Location -Path $path

            try {
                # --- Git Operations ---

                # 1. Checkout the specified branch.
                Write-Host "  Checking out branch '$branch'..."
                git checkout $branch

                # 2. Stage all changes (new, modified, deleted files).
                Write-Host "  Staging all changes..."
                git add .

                # 3. Check if there are any staged changes to commit.
                $status = git status --porcelain
                if ($status) {
                    # If there are changes, commit them with the specified message.
                    Write-Host "  Found changes, committing..."
                    git commit -m "update submodule"
                    
                    # 4. Push the committed changes to the remote repository.
                    Write-Host "  Pushing changes to remote..."
                    git push
                } else {
                    # If there are no changes, print a message and do nothing.
                    Write-Host "  No changes to commit."
                }
            }
            catch {
                # If any of the git commands fail, write an error message.
                Write-Error "An error occurred while processing the submodule at '$path': $_"
            }
            finally {
                # Always return to the original directory, even if errors occurred.
                Pop-Location
            }
        } else {
            # If the submodule's directory doesn't exist, write a warning.
            Write-Warning "Warning: The path '$path' for a submodule was not found."
        }
    }
}

Write-Host "Submodule update script finished."