#!/usr/bin/env ruby
# Register new Swift/.m source files into PearCal.xcodeproj.
# Idempotent — skips files already in the project.
# Run on Mac Mini: ruby scripts/add-ios-sources.rb <file1> <file2> ...

require 'xcodeproj'

project_path = File.expand_path(File.join(__dir__, '..', 'ios', 'PearCal.xcodeproj'))
project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |t| t.name == 'PearCal' }
raise 'PearCal target not found' unless target

group = project.main_group.find_subpath('PearCal', true)

ARGV.each do |rel|
  basename = File.basename(rel)
  if group.files.any? { |f| f.path == basename }
    puts "skip  #{basename} (already registered)"
    next
  end
  ref = group.new_file(File.expand_path(File.join(__dir__, '..', 'ios', 'PearCal', basename)))
  if basename.end_with?('.swift', '.m')
    target.source_build_phase.add_file_reference(ref)
  end
  puts "add   #{basename}"
end

project.save
puts 'project.pbxproj saved'
